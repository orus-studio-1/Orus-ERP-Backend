# E-Invoice (IRN + Signed QR): Implementation Plan (manual mode)

Status: plan only, no code written. This plan follows the same pattern as the e-way bill module (`docs/eway-bill-implementation-plan.md`): **the ERP prepares and validates the invoice data and exports the file the government portal accepts; the user uploads it on the portal and brings the result back (IRN, acknowledgement, signed QR) into the ERP.** No GSP is needed and nothing is faked. The GSP/API provider is added later behind a provider interface.

Statutory values and file formats marked **(confirm)** come from general knowledge of GST/NIC rules and must be checked against the current NIC documents and the sample files on the e-invoice portal, and signed off by the CA, before release. Thresholds and windows live in versioned config, not in code.

Written for: engineers building it and the CA/product owner who will sign off.

## 1. Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Provider | **Manual first.** ERP builds and validates the e-invoice JSON, user uploads it on the portal's bulk tool, then imports the portal's result file (or types the values) back. GSP is Phase 5, behind an `EInvoiceProvider` interface, chosen per company in config. No mock provider. |
| 2 | Documents covered | Sales invoice and credit note in this release. Debit note later (no debit-note document exists today). |
| 3 | Missing IRN | **Soft warning.** Submitting an invoice always succeeds, exactly as e-way bill works. A company setting to hard-block is stored but not enforced in this release. |
| 4 | Existing flows | **Submit, numbering and tax calculation are not changed in this release.** See section 9 for what that means against the boss briefing. |
| 5 | Applicability | Configurable threshold per company, PAN level, with manual override, all effective-dated and CA-verified (section 4). |

## 2. Current state (Orus-ERP-Backend)

- No e-invoice code. `EwayBill.irn` is a reserved empty field. `docs/engineering-spec-gap-audit.md` lists IRN as missing.
- Invoice submit: `controllers/invoices/salesInvoiceLifecycle.controller.ts` (`updateInvoiceStatus`). Credit note submit: `controllers/invoicingExtras/creditNotes.controller.ts`. Edits after submit are already blocked (draft only). Correction is credit note or cancel-and-amend (`amendInvoice`).
- Invoice number is allocated when the **draft is created** (`nextDocumentNo` in `invoices/shared.ts`). Tax is calculated at draft create/update from the lines sent by the client; submit snapshots tax rows (`resolveAndSnapshotInvoiceTaxes`) but does not recompute totals. Tax rows are untyped (free-text label).
- Reusable from the e-way module: GSTIN/state/pincode/HSN/UQC validators (`eway/ewayRules.service.ts`), tax split from row labels with a rate fallback (`splitLineTax`, `classifyLabel` in `ewayPayload.service.ts`), ship-to resolution from the sales order snapshot or customer, dispatch GSTIN options (`dispatchGstinOptions`), export file builder pattern (`toNicBill`, `buildNicBulkFile`), event log table pattern (`EwayBillEvent`), live-bill guard (`assertNoLiveEwayBill`), hourly sweep wired in `index.ts` (`markExpiredBills`), pending report (`pendingReport`), PDF renderer (`utils/pdf.ts`), frontend (`EwayBillPages.tsx`, `EwayBillAction` on the invoice page).
- Customer GSTIN/state: `Customer.gstin`, `Customer.stateCode`. `CustomerAddress` has `stateCode` but no GSTIN.
- Seller GSTINs: `Company.gstin/pan`, `CompanyGstin`, `Branch.gstin`.
- PDF is a hand-written content stream in `utils/pdf.ts`; `qrcode` is a dependency.

## 3. How it works, end to end

```
Invoice submitted (unchanged)
   -> invoice page shows "E-invoice required" (soft warning, if applicable)
User: "Prepare e-invoice"
   -> ERP builds the e-invoice from the submitted invoice, validates it, saves a DRAFT with a frozen payload
   -> problems (bad GSTIN, HSN, pincode, totals mismatch) are listed so they are fixed BEFORE the portal trip
User: "Export JSON" (one or many)
   -> status EXPORTED, file downloads in the portal's bulk-upload format
User uploads the file on the e-invoice portal's bulk generation tool, downloads its result file
User: "Import portal result" (upload the result file) or "Record IRN" (type the values)
   -> ERP matches each row to its e-invoice, validates it, stores IRN, ack no/date, signed invoice, signed QR
   -> status GENERATED, invoice page shows IRN, PDF prints IRN + QR
If the portal rejected a row
   -> "Record portal error" stores the exact code/message, status FAILED, accounts team is notified
   -> fix the data, "Prepare" again (new export), upload again
```

Statuses: `DRAFT` (prepared), `EXPORTED`, `GENERATED`, `FAILED` (portal rejected, error stored), `CANCELLED`, plus `NOT_APPLICABLE` and `SKIPPED` rows so reports can tell "not needed" from "missing".

## 4. Data model

New models (all have `companyId`, so they join the tenant scope automatically; verify with a test). One Prisma migration in the existing timestamp style.

1. **EInvoiceConfig** (per company): `mode` (MANUAL; API reserved and rejected until built, like e-way), `provider`, `hardBlockOnSubmit` (stored, not enforced), `credentialsEncrypted` (unused until GSP), `declared aggregate turnover by PAN and financial year`, `overrideMode` (NONE, FORCE_ON, FORCE_OFF) with `overrideReason/By/At`.
2. **EInvoiceRuleVersion**: effective-dated, never edited once used. `effectiveFrom/To`, `turnoverThreshold`, `reportingWindowDays`, `reportingWindowTurnoverFloor`, `warnAtPercents` (50, 80), `cancelWindowHours`, `shipToGstinMandatoryFrom`, `schemaVersion`, `verifiedByCa` + CA name/date/reference. Lookup = the version in force on the invoice date. No version configured means "needs attention", never a silent default.
3. **EInvoice**: one per invoice or credit note. Source link (`salesInvoiceId` or `creditNoteId`), status, snapshot (`supplierGstin`, `docType` INV/CRN, `docNo`, `docDate`, `financialYear`, buyer and ship-to GSTIN, place of supply, supply type), values (taxable, CGST, SGST, IGST, cess, other, total), the frozen `payload`, result (`irn`, `ackNo`, `ackDate`, `signedInvoice`, `signedQr`, `ewbNo?`), `errorCode/errorMessage`, `exportedAt`, `reportingDeadline` and warning timestamps, `cancelDeadline`, `cancelledAt`, `cancelReason`, `createdById`. One live e-invoice per source document, enforced in the service (as e-way does).
4. **EInvoiceItem**: line snapshot (product, HSN, UQC, quantity, taxable amount, CGST/SGST/IGST/cess rates and amounts), so the export and the printed copy never depend on later master-data changes.
5. **EInvoiceEvent**: append-only (created, edited, exported, result imported, IRN recorded, error recorded, cancelled, warning sent). One table, same as `EwayBillEvent`.

Small additions to existing tables: `CustomerAddress.gstin` (ship-to GSTIN may differ from bill-to; the shipping snapshot copies it). Nothing is added to `SalesInvoice` or `CreditNote` in this release; the e-invoice row carries the GST snapshot, as the e-way bill does.

## 5. Backend design

New folder `src/services/einvoice/`:

- `einvoiceRules.service.ts` (pure): rule-version lookup, applicability decision, reporting deadline and 50%/80% progress, cancel window, doc-number rule (max 16 chars, allowed characters, from the rule version) **(confirm)**. Re-uses the e-way validators instead of copying them.
- `einvoicePayload.service.ts` (pure): builds the e-invoice from an invoice, validates it, and produces the portal bulk-upload JSON (schema 1.1 **(confirm)**: transaction, document, seller, buyer, dispatch, ship-to, item list, value details, reference to the preceding invoice for credit notes). Tax is split with the existing `splitLineTax`; value totals must reconcile with the invoice within the portal's rounding tolerance **(confirm)**.
- `einvoice.service.ts` (database): `checkRequirement`, `createFromInvoice` / `createFromCreditNote`, `updateDraft`, `deleteDraft`, `exportEInvoices`, `importResult` (parses the portal result file, matches rows, validates), `recordIrn` (manual), `recordError`, `recordCancel`, `assertNoLiveEInvoice` (guard), `pendingReport`, `markBreached`/`sendWindowWarnings` (sweep).
- `einvoiceProvider.ts` (reserved, Phase 5): `EInvoiceProvider` interface (`generateIrn`, `cancelIrn`, `getIrnByDocDetails`, `generateEwayBill`, `updateVehicle`). Manual mode is the implementation where "generate" is the export/import round trip. The rest of the code only calls the service, so a GSP later replaces one step.

Import of the portal result (the part that saves typing mistakes):
- Accepts the result file as the portal produces it, with tolerant field names **(confirm against a real sample)**. Each row must carry an IRN (64 hex characters), ack number, ack date, signed invoice and signed QR.
- Matching: by document number + supplier GSTIN + document type. The signed invoice is a signed token whose payload holds the document number, date, GSTIN and IRN; the ERP decodes it (without trusting it) and **cross-checks** those against the e-invoice and against the IRN column before accepting. Mismatch rows are rejected and listed.
- Duplicate IRN on another e-invoice is rejected. Rows that are already GENERATED are skipped. Rows that the portal marked failed are recorded as FAILED with the exact message.
- The whole file is applied in one transaction; the response lists accepted, skipped and rejected rows.

Endpoints (under the invoicing module, same mount style as `/eway-bills`; the brief's `/gst/einvoice/...` paths map onto these and can be aliased):

| Brief | Manual-mode endpoint |
|---|---|
| `POST generate/:salesInvoiceId` | `POST /einvoice` (create draft from invoice or credit note; `dryRun` previews) and `POST /einvoice/:id/export` |
| bulk-generate | `POST /einvoice/export` with `ids` (downloads one bulk file) |
| status/:salesInvoiceId | `GET /einvoice/check?sourceType&sourceId` and `GET /einvoice?salesInvoiceId=` |
| failed (retry queue) | `GET /einvoice?status=FAILED` plus `GET /einvoice/failed` |
| unreported | `GET /einvoice/unreported` |
| cancel/:id | `POST /einvoice/:id/cancel` (records the cancellation done on the portal) |
| GET/PUT settings | `GET/PUT /einvoice/config`, plus `GET/POST /einvoice/rule-versions`, `POST /einvoice/rule-versions/:id/verify`, `PUT /einvoice/applicability` |
| (new) | `POST /einvoice/import-result`, `POST /einvoice/:id/record-irn`, `POST /einvoice/:id/record-error`, `GET /einvoice/:id`, `GET /einvoice/:id/qr` |

Permissions: add an `einvoice` resource to the invoicing module in `ERP_MODULES` (READ, CREATE, SUBMIT, CANCEL, PRINT; config needs MANAGE). Add the new actions to `documentOperations` and register the audit delegate in `middleware/platform.ts`. Every state change writes `audit()` and an `EInvoiceEvent`.

Hooks into existing flows (all after the existing transaction, never failing it):
- Invoice and credit note submit: no change. The invoice page asks `checkRequirement` for the soft warning.
- Cancelling an invoice or credit note that has an e-invoice in EXPORTED/GENERATED is blocked with a clear message (same as `assertNoLiveEwayBill`): cancel the IRN first if inside the window, otherwise issue a credit note. A DRAFT e-invoice is discarded.
- Amend (`amendInvoice`) is only offered for a cancelled invoice, so it already implies the IRN was cancelled.
- A live e-way bill blocks IRN cancellation (portal rule **(confirm)**).

Rules and warnings:
- **Applicability**: document type (invoice/credit note only), buyer has a valid GSTIN or the supply is export/SEZ, company/branch exempt flag, manual override (reason mandatory), then declared PAN turnover (highest figure up to the invoice's financial year) against the threshold of the rule version in force.
- **Reporting window**: `reportingDeadline` is stored when an e-invoice becomes REQUIRED. An hourly sweep (wired like `markExpiredBills`) sends a notification to users holding the einvoice MANAGE permission at 50% and 80% of the window and marks breached ones. The **unreported dashboard** lists applicable invoices with no GENERATED e-invoice, oldest first, with the percentage of the window used.
- **Cancellation**: only until `ackDate + cancelWindowHours`, with a portal reason code **(confirm)**. The API returns `canCancel`, `cancelDeadline`, `secondsLeft`; after the window the UI offers only "Issue credit note". Recording a cancel is a record of what was done on the portal, like e-way cancel.
- **Failure alerts**: recording a portal error notifies the accounts users with the exact code and message. A daily reminder repeats while an e-invoice stays FAILED or an exported file has had no result for N days (config).

QR and print:
- Store `signedQr` as returned. In `utils/pdf.ts`, draw the QR as vector squares from the `qrcode` module matrix (no image needed in the hand-written PDF), plus IRN, ack no and ack date, on `renderInvoicePdf` and the credit note PDF. `GET /einvoice/:id/qr` serves a PNG. Draft/failed e-invoices print without QR.

Ship-to GSTIN (GSTN advisory date 1 Aug 2026 **(confirm)**, already past): captured in `CustomerAddress.gstin`, copied into the shipping snapshot, sent in the ship-to block, and `shipToGstinMandatoryFrom` in the rule version makes `validate` fail when it is missing.

Secrets: portal/GSP credentials are not needed in manual mode. `EInvoiceConfig.credentialsEncrypted` exists for Phase 5 and will use a dedicated key (`GST_CREDENTIALS_KEY`), never `JWT_SECRET`, with masked reads.

## 6. Frontend (Orus-ERP-Frontend-Web)

Read `node_modules/next/dist/docs/` first: `AGENTS.md` warns this Next.js version has breaking changes.

- Sidebar: "E-Invoices" under Invoicing (`sidebarNav.ts`), permission `invoicing:einvoice:read`.
- Pages: list (status filters, multi-select Export), detail (payload preview, validation problems, events, IRN/QR), settings (mode, rule versions with CA verification, PAN turnover and override), dashboards for **Unreported** and **Failed**.
- Invoice and credit note screens: `EInvoiceAction` next to `EwayBillAction` on `sales-invoices/[id]/page.tsx`: status chip, warning banner when required and missing, Prepare, Export, Import/Record IRN, Record error, Cancel (with the live countdown) or "Issue credit note" once the window is over.
- Dialogs: review/edit draft, import portal result (file upload, shows accepted/skipped/rejected), record IRN, record error, cancel.
- Customer forms: ship-to GSTIN on addresses, with validation and a visible error when GSTIN and state code disagree.

## 7. Phases

1. **Foundation** (no portal, no UI): schema + migration, rule-version/applicability/deadline/cancel services with tests, payload builder, validator and export file with tests, `CustomerAddress.gstin`.
2. **Manual end to end (backend)**: create/edit/delete draft, export (single and bulk), import portal result, record IRN, record error, cancel record and guards, notifications and hourly sweep, pending/unreported/failed reports, PDF with QR, permissions, audit.
3. **Frontend**: pages, invoice/credit-note action, dialogs, settings, dashboards.
4. **Sign-off**: run exports on the NIC e-invoice **test portal**, fix the file format against the real sample, CA reviews a generated PDF and the rule versions.
5. **Later**: GSP provider behind the interface (auto generate, retry with backoff, failure alerts from the queue, e-way bill through IRN), debit notes, metering.

## 8. Testing

- Unit: rule-version lookup by date, applicability matrix, reporting deadline and 50%/80%, cancel window boundary, doc-number rule, payload builder (intra-state, inter-state, export, SEZ, discount, ship-to different from bill-to, credit note with preceding invoice), reconciliation of totals, result-file parser (valid, wrong IRN length, mismatched document, duplicate IRN, already generated, rejected row), signed-token cross-check.
- Integration: duplicate-prevention, cancel blocking from invoice cancel, tenant isolation, permissions, soft warning never blocks submit, sweep sends each warning once.
- Manual: upload an exported file on the NIC test portal and confirm it is accepted; import the portal's real result file.

## 9. What this release does not do (against the boss briefing)

Choosing the e-way-style manual mode means these parts of the briefing are **not** delivered now. They are real gaps, not details:

| Briefing item | Status | Consequence |
|---|---|---|
| Automatic IRN after submit, background job | Not in this release | Someone must export/upload/import. The unreported dashboard and reminders are the control. |
| Retry with exponential backoff, alert after N failures | Not in this release | The portal is not called by the ERP, so there is nothing to retry. Failures are recorded by hand and alerted at once. |
| GSP adapter, outage handling | Interface reserved only | Needed for one-click generation. |
| Invoice number sequential, gap-free, per GSTIN per financial year, allocated at submit | **Not changed** | Today the number is taken on draft creation and the sequence is not per GSTIN/year, so deleted drafts leave gaps. A CA may object. Recommend a separate, small change (and the CA's view) before go-live. |
| Tax always recomputed on the server at submit | **Not changed** | Totals come from the draft as the client sent them. The e-invoice validator catches totals that do not reconcile, but does not correct them. Recommend a separate change. |
| Typed CGST/SGST/IGST column | Not added | Same limitation as e-way: split from row labels, with a rate fallback; a differently labelled template is split by supply direction. |
| `einvoice.perMonth` entitlement and metering | Not in this release | No entitlement system exists yet. |

Items 4 and 5 in the table are compliance-relevant and independent of manual or API mode; they should be decided separately rather than silently dropped.

## 10. Risks

- Portal file and result formats follow published formats from memory; the first real upload decides. The e-way module had the same caveat.
- Manual mode depends on staff discipline: a missed upload is the main failure. Mitigation: unreported dashboard, 50%/80% warnings, daily reminders.
- Late reporting cannot be retried into success; the CA must define the process (credit note and re-issue).
- Master-data quality (GSTIN, HSN, pincode, UQC) will cause most portal rejections. The validator runs before export for exactly this reason.
- Statutory drift: effective-dated rule versions with CA verification are the control.

## 11. Open items for the business

1. Who uploads files on the portal and who owns the portal login?
2. Declared turnover per PAN and financial year: who enters it, and does the CA confirm each year?
3. Should the gap-free numbering and server-side tax recompute (section 9) be done before go-live, as a separate change?
4. Which GSTIN issues invoices when a company has several (branch, warehouse state, or chosen per invoice)? E-way already asks the user to choose.
5. Debit notes needed in the first release?
6. Any exempt categories to flag at launch?

## 12. Implementation status (manual mode, first release)

Built: phases 1 to 3 (backend and frontend) for sales invoices and credit notes. Not built: the GSP/API provider and its interface file, debit notes, metering, hard-block enforcement, and everything in section 9.

What exists:

- **Schema** (`prisma/migrations/20261019100000_einvoice_manual`): `EInvoiceConfig`, `EInvoiceRuleVersion`, `EInvoiceTurnover`, `EInvoice`, `EInvoiceItem`, `EInvoiceEvent`, `EInvoiceWarning`; `CustomerAddress.gstin`; `einvoiceExempt` on `Company` and `Branch`. The SQL was generated by `prisma migrate diff` and has **not been run against a database**.
- **Backend** (`src/services/einvoice/`): `einvoiceRules.service.ts` (pure rules), `einvoicePayload.service.ts` (build, validate, portal JSON), `einvoiceResult.service.ts` (read the portal result, decode the signed token, cross-check), `einvoiceConfig.service.ts` (config, rule versions, turnover, applicability), `einvoice.service.ts` (prepare, edit, refresh, export, import, record IRN/error/cancel, guard, reports), `einvoiceJobs.ts` (hourly sweep). Controller `invoicingExtras/einvoice.controller.ts`, routes `routes/einvoice.routes.ts` mounted at `/invoicing/einvoice` (resource `einvoice` added to the invoicing module).
- **Hooks into existing flows**: cancelling an invoice or credit note runs `assertNoLiveEInvoice` (blocks when an IRN exists or the file was exported; discards a draft or failed e-invoice); the invoice PDF prints IRN, ack no/date and a vector QR when an e-invoice is GENERATED; the ship-to snapshot now carries the address GSTIN; the customer address endpoint validates a ship-to GSTIN and its state.
- **Frontend**: `EInvoicePages.tsx` (list, unreported, rejected, settings, detail, prepare dialog, import dialog), `EInvoiceAction` on the invoice page and on submitted credit notes, sidebar entry, ship-to GSTIN field on the new-address dialog, "Rejected by portal" badge.
- **Tests**: 56 new backend tests (rules, payload, result parsing, import/record/cancel/guard flows, an end-to-end walk on an in-memory transaction, PDF). Frontend: type-check only.

Differences from the plan above:

- **Statuses** are DRAFT, EXPORTED, GENERATED, FAILED, CANCELLED. There are no NOT_APPLICABLE/SKIPPED rows: "not required" is computed by `checkRequirement` and the unreported report instead.
- **Warning bookkeeping** is a small `EInvoiceWarning` table (one row per document and level, so each warning is sent once). The `warned50At/80At/breachedAt` columns were not added to `EInvoice`, because documents with no e-invoice row also need warnings.
- **Override and turnover**: the override (always/never report, with reason) is per company in `EInvoiceConfig`; declared turnover is stored per company, PAN and financial year (the tenant layer scopes every query to one company, so a figure cannot be read across companies).
- **Permissions**: the gate is the invoicing module's `einvoice` resource with the action taken from the path, as for e-way bills. A separate MANAGE gate for settings is not enforced.
- **Notifications** go to every active user of the company, as the other sweeps do, not only to a permission group.
- **Edit/refresh**: `Refresh from document` re-reads the invoice and master data into a draft or failed e-invoice; editing after an export makes the file stale (status back to DRAFT). `resplit` on an edit re-types CGST+SGST <-> IGST on the e-invoice only; it is for the CA to approve.
- **Tax in the wrong form** (for example CGST/SGST rows on a supply to another state) is reported as an error, not silently changed; the tax split uses the e-way logic (stored row labels first, rate and supply direction as fallback).
- **Supply type** is B2B, or export with/without payment from the buyer's country and the tax charged. SEZ cannot be detected (no SEZ flag on the customer), so it must be set on the e-invoice by hand.
- **Credit notes** have no PDF in the ERP, so the QR prints on the invoice PDF only.
- **The unreported report and sweep** judge applicability with the company's first (default) GSTIN.
- The `EInvoiceProvider` interface file was not created; manual mode is the only implementation and `mode` rejects anything else.

Before go-live:

1. Run the migration on a database and click through the flow once (prepare, export, import, cancel, invoice cancel guard, PDF).
2. Check the exported file and the result-file parser against the NIC e-invoice test portal and a real result file; field names, the bulk-file layout, schema version, the export place-of-supply code and the round-off limit are from memory.
3. Add and CA-verify a rule version and the PAN turnover, otherwise every document shows "rules not configured".
4. Decide section 9 (gap-free numbering and server-side tax recompute) with the CA.

## 13. Verification record (20 Oct 2026)

Run on a throw-away local PostgreSQL (all migrations from scratch, including `20261019100000_einvoice_manual` and `20261019110000_customer_sez`), the real backend over HTTP, and the real frontend in Chrome. Nothing was run against the portal itself.

**Run and passing**
- Backend: 107 unit tests; an HTTP end-to-end script of 67 checks (rule version and CA sign-off, turnover, prepare, export, import, typed IRN, QR and PDF, IRN cancel inside and after the window, invoice-cancel guard, credit note, portal rejection and notification, tax re-type with approval, SEZ, unreported report) and the hourly sweep (50% and 80% warnings sent once, nothing repeated on the second run).
- The QR printed on the invoice PDF was rendered, scanned, and decodes to exactly the stored signed QR.
- Frontend: 21 browser checks (list, unreported, invoice warning, prepare dialog, draft, export download, typed IRN with a refused short IRN, QR shown, invoice IRN chip, import dialog, settings, re-type approval field, SEZ checkbox) with no browser errors.

**Checked against public NIC/GSTN material, and corrected**
- NIC sandbox validations: document number 1 to 16 characters not starting with 0, "/" or "-"; dates dd/mm/yyyy; export means recipient GSTIN URP, state code 96, PIN 999999, place of supply 96; round-off -99.99 to 99.99; HSN 4, 6 or 8 digits; exports and SEZ are always inter-state; totals tolerance of one rupee; documents dated before 1 April 2025 are not accepted. Added: the date check, the supply-type list, three-decimal quantity and price.
- Supply types: SEZWP no longer exists; it is SEZWPA (payment authorized) and SEZWPNA (not authorized), plus RCMDOM and RCMIMP. The edit screen and the validator use the new list.
- Applicability threshold is **5 crore** (CBIC Notification 10/2023) on turnover in an **earlier** financial year; the 30-day reporting limit is for 10 crore and above (GSTN advisory 5 Nov 2024). The earlier suggested threshold of 10 crore was wrong and the turnover year rule was too loose; both fixed. The reporting window now counts the document day as day 1 in Indian time (dated 1 April: reportable through 30 April).
- Ship-to GSTIN (GSTN advisory 17 Jun 2026, from 1 Aug 2026): URP is accepted, and the same GSTIN as the buyer is refused.
- The bulk upload file may not exceed 2 MB; the export now refuses a larger selection.
- The NIC sample generate-IRN responses (two, kept in `fixtures/nic-sample-responses.json`) decode with the parser: response shape `{ Status, Data, ErrorDetails }`, signed invoice payload, and the QR payload (SellerGstin, DocNo, DocTyp, DocDt, TotInvVal, Irn, IrnDt). The QR now also cross-checks typed entries.
- The 24-hour IRN cancel window, and that an active e-way bill blocks IRN cancellation, are confirmed by several sources.

**Still not verified (needs the portal or the CA)**
1. The layout of the **bulk upload result file**. It is not published; the parser reads the single-response shape above and tolerant variants. Upload one exported file on the NIC e-invoice test portal and import what it gives back. The manual "Record IRN" entry is the fallback.
2. The **cancel reason codes** 1 to 4 (Duplicate, Data entry mistake, Order cancelled, Others) could not be confirmed from public pages.
3. The portal's own **error codes** (for example 2150) were not available; messages are stored as the portal gives them.
4. The **CA's verification** of the rule version and the PAN turnover. Only the CA can sign those off; the screen records the name and reference.
5. Whether the portal accepts **ship-to details with the same GSTIN as the buyer** in the way the advisory describes is decided by the portal; the ERP follows the advisory text.

## 14. Setup tab (no database editing)

The E-Invoices page now opens on a **Setup** tab for a company that is not ready. It shows a checklist (GSTIN, PAN, legal name/address/city/pincode, rule version in force, CA verification, turnover of an earlier year) and lets the user do each step on screen: company GST details (`GET/PUT /invoicing/einvoice/company-profile`, validated: GSTIN format, PAN agreeing with the GSTIN, 6-digit pincode, state taken from the GSTIN), "Add suggested rule version", "Record CA verification" and "Save turnover". `GET /invoicing/einvoice/readiness` feeds the checklist and the "Setup is not finished" banner. An invoice of a company with no GSTIN now shows "E-invoice is not set up" instead of a Prepare button. Verified in Chrome on a company with no GST details: setup, prepare, export and the seller block of the exported file, all from the browser.

Known, not part of this work: customer and invoice numbers are generated per company but are globally unique in the database, so the first customer or invoice of a second company in the same database can fail with "customerNo already exists".

## 15. Invoice print (PDF)

The sales invoice PDF (`utils/pdf.ts`, `renderInvoicePdf`) was redone in the style of the e-way bill print: coloured title band, invoice date / due date / place of supply / sales order, seller, bill-to and ship-to boxes (seller from the company, buyer from the customer, ship-to from the invoice's address snapshot), an items table with HSN/SAC and tax %, a tax summary by tax row, amount in Indian words, HSN summary, terms and notes, signature line, page numbers and more pages when there are many items. When the invoice has a generated e-invoice the IRN, acknowledgement number/date and the signed QR sit in their own box under the dates. The print format's title, footer and its "amount in words", "HSN summary" and "payment terms" switches are honoured. Checked on a real PDF from the running backend; the QR on the page decodes to the stored signed QR.
