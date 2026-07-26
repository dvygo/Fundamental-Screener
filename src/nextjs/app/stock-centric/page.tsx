import StockCentric from "@/components/StockCentric";

// Server component: read ?symbol= here so the deep-linked stock is selected on
// the first render (no RELIANCE flash). `searchParams` is awaited to support both
// the promise (current Next) and plain-object forms.
export default async function StockCentricPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string | string[] }>;
}) {
  const sp = await searchParams;
  const raw = sp?.symbol;
  const symbol = Array.isArray(raw) ? raw[0] : raw;
  return <StockCentric initialSymbol={symbol} />;
}
