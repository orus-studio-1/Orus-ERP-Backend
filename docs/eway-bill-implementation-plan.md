# E-Way Bill: Implementation Plan

Status: plan only, no code written. Scope decisions are settled in section 1. Statutory rules marked **(confirm)** come from general knowledge of GST/NIC rules and must be verified against current NIC documentation before release.

## 1. Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Provider | **Phase 1 is manual: the ERP builds and validates the NIC bulk-upload JSON, the user uploads it on the portal and records the returned number.** The GSP/API provider is added later behind a provider interface. No GSP is chosen yet. |
| 2 | E-invoice / IRN | Out of scope. An empty `irn` field is reserved on the e-way bill so it can be added later. |
| 3 | Missing bill at dispatch | **Soft warning.** Submitting an invoice or delivery note always succeeds. A company-level setting can switch to a hard block later. |
| 4 | Dispatch GSTIN | **Chosen per document**, defaulted from the dispatch warehouse's state. Must match the warehouse state or the ERP blocks generation with an error. |
| 5 | Consolidated e-way bill | Not in this release. One bill per document. Each bill stores the vehicle and transporter, so consolidation can be added later without rework. |

Known limitation: splitting one invoice across several vehicles is not supported in phase 1.

## 2. Current state of the code (Orus-ERP-Backend)

- Only trace of e-way bill: `SalesOrder.eWayBillNo` (plain string) and `transporterInfo` (free JSON), saved from `req.body` in `controllers/sales/orders.controller.ts` with no validation. `StockTransferOrder` and `GateEntry` have `transporter` and `vehicleNo`. `docs/engineering-spec-gap-audit.md` lists e-way bill as missing.
- Seller GSTIN: `Branch.gstin`, `Company.gstin`, multi-state `CompanyGstin`. Customer GSTIN is stored in `Customer.taxId` (no `gstin` field). `services/sales/tax.service.ts` derives state code and CGST/SGST vs IGST.
- Gaps: `SalesInvoice` has no `placeOfSupply`, `taxMode` or ship-to. `DeliveryNote` has no transport fields, addresses or values, and its items have no price. `Warehouse` has no state code, pincode or GSTIN. `Customer` has no state code. Tax rows (`SalesInvoiceItemTax`, `SalesInvoiceTax`) are keyed by free-text `label`, not typed CGST/SGST/IGST/Cess.
- Reusable infrastructure: `BackgroundJob` (`enqueueJob`, `registerJobHandler`, retry with backoff), env-var gateway pattern, `credentialsEncrypted` pattern, `Attachment` + S3, `qrcode`, `audit()`, `allocateDocumentNo`, `tenantModels` (`utils/tenant.ts`), `ERP_MODULES` (`utils/accessControl.ts`), `auditDelegates` and `documentOperations` (`middleware/platform.ts`).

## 3. Where an e-way bill is needed

| Flow | Trigger in code | Document type | Phase |
|---|---|---|---|
| Sales invoice (goods) | Submit in `invoices/salesInvoiceLifecycle.controller.ts` | INV | 1 |
| Delivery note | Submit in `deliveryNotes.controller.ts` | INV/CHL | 1 |
| Inter-state / inter-GSTIN stock transfer | `dispatch` in `inventory/completion.controller.ts` | CHL | 3 |
| Purchase return to supplier | `PurchaseReturn` submit | CHL / debit note | 3 |
| Inward goods from unregistered supplier | `GateEntry` / `PurchaseReceipt` | - | 4 (optional) |
| Credit note / sales return | `CreditNote` | - | 4 (optional) |
| Export / SEZ | `taxMode` EXPORT/SEZ | sub-supply types 3 and 1 | handled explicitly in phase 1 |

One bill per source document. A document with a live bill cannot get a second one. Threshold is ₹50,000 consignment value **(confirm)**, held in config, not code.

## 4. Data model

New models (all added to `tenantModels`, with a Prisma migration in the existing timestamp style):

1. **EwayBillConfig**: per company and GSTIN. Mode (MANUAL or API), provider, sandbox/live, encrypted API credentials and token cache (unused in phase 1), value threshold, default transport mode, default transporter, `hardBlockOnDispatch` flag (default off).
2. **EwayBill**: one row per bill.
   - Identity and status: `ewbNo`, `ewbDate`, `validUntil`, status (DRAFT, EXPORTED, GENERATED, CANCELLED, EXPIRED, FAILED), `source` (MANUAL or API), `irn` (reserved, empty).
   - Source link: `sourceType` plus optional FKs `salesInvoiceId`, `deliveryNoteId`, `stockTransferOrderId`, `purchaseReturnId`.
   - Document snapshot: `supplyType`, `subSupplyType`, `docType`, `docNo`, `docDate`, `transactionType`.
   - Parties: dispatch GSTIN chosen on the document (snapshot), from and to GSTIN, name, address, pincode, state code, plus actual dispatch-from and ship-to state codes.
   - Values: taxable, CGST, SGST, IGST, cess, other, total.
   - Transport: mode, distance, transporter id and name, transport doc number and date, current vehicle number and type.
   - Provider/audit data: request payload and response JSON, error code and message, attempts, `cancelledAt`, `cancelReason`, attachment id of the printed copy.
   - Uniqueness: one active bill per source document.
3. **EwayBillItem**: product, HSN, UQC, quantity, taxable amount, CGST/SGST/IGST/cess rates.
4. **EwayBillVehicleUpdate**: Part B history (vehicle, from place and state, reason, remarks, transport doc, timestamp).
5. **EwayBillExtension**: validity extensions (reason, remaining distance, current place, new `validUntil`).
6. **Transporter**: GSTIN/transporter id, name, default vehicle.

Field additions to existing models:

- `Customer`: `gstin`, `stateCode`, `gstRegistrationType`; backfill from `taxId` in the migration, with a review report for rows that don't parse.
- `Warehouse`: `stateCode`, `pincode`, `gstin`, address lines.
- `DeliveryNote`: `transporterId`, `vehicleNo`, `transportMode`, `distanceKm`, `shippingAddressSnapshot`, `taxMode`, `placeOfSupply`.
- `SalesInvoice`: `placeOfSupply`, `taxMode`, `shippingAddressSnapshot`, `dispatchGstin`, current-bill reference, `ewayBillRequired`.
- `StockTransferOrder`: transport mode, distance. `PurchaseReturn`: transporter, vehicle.
- Typed tax component (`CGST`, `SGST`, `IGST`, `CESS`) on `TaxTemplateLine` and `SalesInvoiceItemTax`. This is the largest hidden task: existing rows only have text labels, so a mapping and backfill is needed.
- `SalesOrder.eWayBillNo`: stop writing it from `req.body`; keep the column until existing data is migrated, then show it read-only from the linked bill.

Payload field mapping:

| Payload group | Source |
|---|---|
| `supplyType`, `subSupplyType` | Outward for sales/transfers, inward for purchase returns; sub-type from `taxMode` and flow, manual override allowed |
| `docType`, `docNo`, `docDate` | Invoice / delivery note / transfer / return number and date |
| `fromGstin`, name | Dispatch GSTIN chosen on the document (from `CompanyGstin`/`Branch`/`Company`) |
| `fromAddr`, `fromPincode`, `fromStateCode` | `Warehouse` (new fields), falling back to branch address |
| `toGstin`, name | `Customer.gstin`, or `URP` if unregistered |
| `toAddr`, `toPincode`, `toStateCode` | Ship-to snapshot, falling back to billing |
| `transactionType` | Regular if bill-to equals ship-to, otherwise bill-to/ship-to |
| Values and tax split | Aggregated from typed tax rows |
| Line items | Invoice or delivery lines: HSN, unit mapped to UQC, rates |
| Transport and vehicle | Delivery note / invoice transport block |

## 5. Backend design

New folder `src/services/eway/`:

- `ewayRules.service`: threshold, exemptions, validity, distance rules. Rules live in config.
- `ewayPayload.service`: builds the NIC payload from a source document and validates it.
- `ewayExport.service` (phase 1): builds the NIC bulk-upload JSON for one or many bills.
- `ewayProvider.service` (phase 2): provider interface (authenticate, generate, cancel, update Part B, extend, fetch). The manual mode and the API mode both implement it. The rest of the code calls only the interface.
- `jobs.ts` (phase 2): registers an `EWAY_GENERATE` job handler on the existing job service.

Endpoints, under the `invoicing` module:

- `POST /eway-bills` (create draft from a source document), `GET /eway-bills`, `GET /eway-bills/:id`.
- Phase 1: `POST /eway-bills/:id/export` and `GET /eway-bills/export?ids=` (bulk), `POST /eway-bills/:id/record-number` (manual entry of the returned number, date and validity), plus manual-record endpoints for cancel and Part B update.
- Phase 2: `POST /eway-bills/:id/generate`, `/cancel`, `/update-vehicle`, `/extend`.
- Both: `GET /eway-bills/:id/pdf`, `GET /eway-bills/pending`, `GET /eway-bills/expiring`, config endpoints.
- Add `generate`, `extend`, `export` to `documentOperations` and register the audit delegate so before-snapshots work.

Permissions: add an `eway-bills` resource to the invoicing module in `ERP_MODULES` with READ, CREATE, SUBMIT, CANCEL, PRINT. Config requires MANAGE.

Hooks into existing flows:

- Invoice submit and delivery note submit evaluate the rules after the DB transaction commits. Result is one of: not required, ready, or warning with reason. Submit never fails because of the e-way bill (decision 3).
- Cancelling an invoice or delivery note that has a live bill shows a warning and requires the bill to be cancelled first.
- The provider call, when it exists, always runs outside the stock/ledger posting transaction, so a provider outage never rolls back a submit.

Validation before export or generation:

- GSTIN format, with the first two digits matching the state code.
- Dispatch GSTIN state equals warehouse state (decision 4).
- Pincode and state consistency, HSN of 4/6/8 digits, unit mapped to a valid UQC.
- Distance present, Part B (vehicle or transport doc) present, tax split reconciles to invoice totals within tolerance.
- Manual number entry: 12 digits, duplicate check.

Cancel rules **(confirm)**: within 24 hours of generation and before goods are verified in transit. Outside the window the UI explains that it cannot be cancelled.

Config and env: add `EWAY_PROVIDER`, `EWAY_API_BASE_URL` and key names to `.env.example` in phase 2. Per-company credentials go in `EwayBillConfig`, encrypted.

PDF and QR: extend `utils/pdf.ts` and `qrcode` to render the bill, stored as an `Attachment` on S3.

## 6. Frontend design (Orus-ERP-Frontend-Web)

Read `node_modules/next/dist/docs/` first: `AGENTS.md` warns this Next.js version has breaking changes.

- Sidebar: "E-Way Bills" under Invoicing in `sidebarNav.ts`, permission `invoicing:eway-bills:read`.
- Pages: list with status filters and "expiring today" view; detail page with payload preview, errors and vehicle/extension history; settings page for mode, threshold and (phase 2) credentials.
- Document screens (sales invoice, delivery note, later stock transfers): transport section, e-way bill status chip, dispatch GSTIN selector, "Create e-way bill" button, warning banner when required and missing.
- Dialogs: review/edit payload, export JSON, record returned number, update vehicle, extend validity, cancel (reason required).
- Master data forms: customer GSTIN and state code, warehouse state and pincode, transporter master.

## 7. Phases

1. **Foundation**: schema migration, typed tax components, master-data fields, `taxId` backfill and review report, config model, rules service, payload builder with unit tests (same style as `tax.service.test.ts`).
2. **Manual end to end (first release)**: create bill from invoice and delivery note, validations, JSON export (single and bulk), record returned number, cancel and Part B recording, PDF, list/detail UI, soft-warning banners, and the **pending-bills report** (shipped goods without a bill).
3. **Other flows**: stock transfer dispatch, purchase return, expiring-bill alerts.
4. **API provider**: choose GSP, implement provider interface, `EWAY_GENERATE` job, generate/cancel/update/extend through the API, switch per company in config, sandbox end-to-end tests. Optional inward bills and credit notes.
5. **Later**: consolidated e-way bill, vehicle split, e-invoice/IRN, GSTR links.

## 8. Moving from manual to API later

- Same payload, tables, screens and statuses in both modes. Only the generate step changes.
- Each bill stores `source` (MANUAL or API); the number, date and validity are real fields in both modes.
- Mode is a per-company config switch with no data migration. Bills created manually stay valid.
- Risks in manual mode: mistyped numbers (mitigated by format and duplicate checks) and cancel/Part B done on the portal but not recorded in the ERP (the API mode fixes this by reading status back).

## 9. Testing

- Unit tests: rules, payload builder for CGST/SGST, IGST, export and SEZ, GSTIN/state/UQC validation, typed tax aggregation.
- Integration tests: invoice and delivery note submit with and without a required bill, duplicate prevention, cancel-blocking, tenant isolation.
- Manual check: upload an exported JSON on the NIC sandbox/test portal and confirm it is accepted.
- Phase 4: provider sandbox tests, retry and error-classification tests.

## 10. Risks

- Typed tax split accuracy (largest hidden task).
- Missing GSTIN and state data on existing customers and warehouses, so the backfill needs review.
- Statutory rules (threshold, exemptions, validity) change; keep them in config and re-verify before release.
- Manual mode depends on staff discipline; the pending-bills report is the control.
- Without a GSP or NIC registration, "one-click" generation is not met; the first release is "ERP prepares, user uploads".

## 11. Open items for the business

- GSP selection and sandbox access (needed only for phase 4).
- Do they run their own trucks with multiple drops (decides whether consolidated bills are ever needed)?
- Who in the company will upload files to the NIC portal in phase 2, and who owns portal credentials?

## 12. Implementation status (manual mode, first release)

Built: phases 1 and 2 for sales invoices and delivery notes, plus Part B / extension / cancel recording, PDF, the pending and expiring reports, and the cancel guards. Not built: stock transfer and purchase return bills (phase 3), the GSP/API provider (phase 4), QR code on the PDF.

Differences from the plan above:

- **Tax split** is read from the invoice tax row labels (CGST, SGST, IGST, Cess), with a fallback to the plain rate and the supply direction. The typed tax-component column was not added, so a template whose tax rows are labelled something else is split by direction instead.
- **Events** (export, number recorded, vehicle change, extension, cancel) are one `EwayBillEvent` table instead of separate vehicle-update and extension tables. There is no transporter master; transporter is free text on the bill.
- **Invoice and delivery note fields** (`placeOfSupply`, `taxMode`, ship-to) were not added. The ship-to comes from the sales order's shipping address snapshot and falls back to the customer.
- **Soft warning** is shown by the E-way bill status on the invoice page; submit itself is never touched. The hard-block setting is stored but not enforced.
- **Cancelling** an invoice or delivery note with an exported, generated or expired bill is blocked until the bill is cancelled; a draft bill is discarded.
- NIC bulk-upload field names and the version string follow the published format from memory and must be checked against the sample file on the portal before go-live. Threshold, validity and the 24 hour cancel window are in `ewayRules.service.ts`.
