export function discountedPrice(
	priceCents: number,
	discountPercent: number,
): number {
	const multiplier = 1 + discountPercent / 100;
	return Math.round(priceCents * multiplier);
}
