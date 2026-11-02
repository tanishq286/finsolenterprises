import { api } from "@/lib/api/server";
import { handleApiError } from "@/lib/api/guard";
import { MyTraces } from "@/components/search/my-traces";
export const metadata = { title: "My trace requests", robots: { index: false } };
export default async function MyTracePage() {
  let items: { id: string; reference: string; status: string }[];
  try {
    items = await api<typeof items>("traces", { session: true });
  } catch (e) {
    handleApiError(e, "/traces");
  }
  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-semibold">My trace requests</h1>
      <MyTraces initial={items} />
    </div>
  );
}
