// Turns the ship-to choice on a document into a snapshot saved on it. 'primary' (or nothing) means the
// customer's own address, which the e-way bill already falls back to, so no snapshot is stored for it.
export async function resolveShippingSnapshot(tx: any, customerId: string, shippingAddressId?: string | null) {
  if (!shippingAddressId || shippingAddressId === 'primary') return undefined;
  const saved = await tx.customerAddress.findFirst({ where: { id: shippingAddressId, customerId } });
  if (!saved) throw new Error('Shipping address not found for this customer');
  return { label: saved.label, address: saved.address, city: saved.city, state: saved.state, stateCode: saved.stateCode, country: saved.country, zip: saved.zip };
}
