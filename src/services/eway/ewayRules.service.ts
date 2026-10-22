// Statutory rules for the e-way bill. They are kept here (and the threshold in EwayBillConfig) so a rule
// change is a one-file edit. Values below follow the general NIC rules and must be re-verified against
// the current NIC documentation before release.

export const DEFAULT_VALUE_THRESHOLD = 50000;
export const MAX_DISTANCE_KM = 4000;
// A bill can be cancelled on the portal within 24 hours of generation, if goods are not verified in transit.
export const CANCEL_WINDOW_HOURS = 24;

export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const HSN_PATTERN = /^(\d{4}|\d{6}|\d{8})$/;
export const EWB_NUMBER_PATTERN = /^\d{12}$/;
export const PINCODE_PATTERN = /^[1-9]\d{5}$/;
// Plate forms the NIC lists: KA12KA1234, KA12K1234, KA123456, KAR1234, KA123K1234, KA12KAR1234, plus the
// temporary/defence/BP/NP forms (TM, DF, BP, NP followed by digits) and the older TRxxxxxx form.
export const VEHICLE_PATTERN = /^([A-Z]{2}\d{1,3}[A-Z]{0,3}\d{4}|[A-Z]{3}\d{4}|(TR|TM|DF|BP|NP)\d{6,7}|[A-Z]{2}\d{2}[A-Z]\d{4})$/;

export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '99': 'Other Country', '97': 'Other Territory',
};

export const OTHER_COUNTRY_STATE_CODE = '99';
export const EXPORT_PINCODE = '999999';

const stateNameIndex = new Map(Object.entries(STATE_CODES).map(([code, name]) => [normalizeName(name), code]));
// Common alternate spellings seen in customer master data.
for (const [alias, code] of Object.entries({ orissa: '21', uttaranchal: '05', pondicherry: '34', 'jammu & kashmir': '01', 'andaman & nicobar islands': '35', 'dadra & nagar haveli': '26', daman: '26', 'daman & diu': '26', 'nct of delhi': '07', 'new delhi': '07' })) stateNameIndex.set(normalizeName(alias), code);

function normalizeName(value: string) { return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

export function stateCodeFromName(name?: string | null) {
  if (!name) return null;
  const value = String(name).trim();
  if (/^\d{2}$/.test(value) && STATE_CODES[value]) return value;
  return stateNameIndex.get(normalizeName(value)) || null;
}

export function normalizeGstin(value?: string | null) { return String(value || '').replace(/\s+/g, '').toUpperCase(); }
export function isValidGstin(value?: string | null) { return GSTIN_PATTERN.test(normalizeGstin(value)); }
export function stateCodeOfGstin(value?: string | null) { const gstin = normalizeGstin(value); return GSTIN_PATTERN.test(gstin) ? gstin.slice(0, 2) : null; }
export function normalizeVehicleNo(value?: string | null) { return String(value || '').replace(/[\s-]/g, '').toUpperCase(); }

// Unit symbols used in the ERP -> the UQC codes the NIC accepts.
const UQC_BY_SYMBOL: Record<string, string> = {
  nos: 'NOS', no: 'NOS', number: 'NOS', numbers: 'NOS', unit: 'NOS', units: 'NOS', pcs: 'PCS', pc: 'PCS', piece: 'PCS', pieces: 'PCS',
  kg: 'KGS', kgs: 'KGS', kilogram: 'KGS', kilograms: 'KGS', g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS', grams: 'GMS',
  l: 'LTR', ltr: 'LTR', litre: 'LTR', liter: 'LTR', litres: 'LTR', liters: 'LTR', ml: 'MLT', mtr: 'MTR', m: 'MTR', meter: 'MTR', metre: 'MTR', meters: 'MTR',
  cm: 'CMS', sqm: 'SQM', 'sq.m': 'SQM', sqft: 'SQF', 'sq.ft': 'SQF', box: 'BOX', boxes: 'BOX', bag: 'BAG', bags: 'BAG', bottle: 'BTL', btl: 'BTL',
  carton: 'CTN', ctn: 'CTN', dozen: 'DOZ', doz: 'DOZ', pair: 'PRS', pairs: 'PRS', set: 'SET', sets: 'SET', roll: 'ROL', rolls: 'ROL',
  ton: 'TON', tonne: 'TON', tons: 'TON', mt: 'TON', can: 'CAN', pack: 'PAC', packs: 'PAC', bundle: 'BDL', bdl: 'BDL', tube: 'TUB', tubes: 'TUB',
};
export const VALID_UQC = new Set([...Object.values(UQC_BY_SYMBOL), 'OTH', 'BAL', 'BKL', 'BOU', 'BUN', 'CCM', 'CBM', 'DRM', 'KLR', 'KME', 'MTS', 'PLT', 'QTL', 'TBS', 'TGM', 'THD', 'TOL', 'UNT', 'YDS', 'UGS', 'GGR', 'GRS', 'BDL']);

export function uqcFor(symbolOrName?: string | null) {
  const key = String(symbolOrName || '').trim().toLowerCase();
  if (!key) return null;
  if (UQC_BY_SYMBOL[key]) return UQC_BY_SYMBOL[key];
  const upper = key.toUpperCase();
  return VALID_UQC.has(upper) ? upper : null;
}

export const TRANSPORT_MODES: Record<string, number> = { ROAD: 1, RAIL: 2, AIR: 3, SHIP: 4 };
export const VEHICLE_TYPES = ['R', 'O'] as const; // Regular, Over-dimensional cargo

export function isEwayRequired(input: { totalValue: number; threshold?: number; hasGoods: boolean }) {
  const threshold = input.threshold ?? DEFAULT_VALUE_THRESHOLD;
  if (!input.hasGoods) return { required: false, reason: 'Document has no goods (services only)' };
  if (input.totalValue <= threshold) return { required: false, reason: `Consignment value is not above the ${threshold} threshold` };
  return { required: true, reason: `Consignment value ${input.totalValue.toFixed(2)} is above the ${threshold} threshold` };
}

// One day per 200 km (100 km for over-dimensional cargo), at least one day. The portal's own result is
// authoritative: this is only the suggestion shown when the user records the generated number.
export function suggestedValidityDays(distanceKm: number, odc = false) {
  const perDay = odc ? 100 : 200;
  return Math.max(1, Math.ceil(Math.max(0, distanceKm) / perDay));
}

// Validity ends at 23:59 Indian time on the last day, whatever the server's own time zone is.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
export function suggestedValidUntil(generatedAt: Date, distanceKm: number, odc = false) {
  const ist = new Date(generatedAt.getTime() + IST_OFFSET_MS);
  ist.setUTCDate(ist.getUTCDate() + suggestedValidityDays(distanceKm, odc));
  ist.setUTCHours(23, 59, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

export function canCancelOnPortal(generatedAt: Date, now = new Date()) {
  return now.getTime() - generatedAt.getTime() <= CANCEL_WINDOW_HOURS * 3600 * 1000;
}
