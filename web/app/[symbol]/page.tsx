import { Terminal } from "@/components/Terminal";

export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return <Terminal initialSymbol={decodeURIComponent(symbol).toUpperCase()} />;
}
