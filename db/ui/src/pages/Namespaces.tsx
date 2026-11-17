// Namespaces: every prefix under ns/ in the bucket, with its size and index status.
// turbopuffer concept: a namespace is just a prefix in object storage, created on first write.

import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, fmtBytes, fmtNum, type Metadata } from "../api";
import { Code, Empty, ErrorNote, IndexStatus } from "../components/ui";

export default function Namespaces() {
  const list = useQuery({
    queryKey: ["namespaces"],
    queryFn: () => api<{ namespaces: { id: string }[] }>("/v1/namespaces?page_size=1000"),
    refetchInterval: 5000,
  });
  const names = list.data?.namespaces.map((n) => n.id) ?? [];
  const metas = useQueries({
    queries: names.map((ns) => ({
      queryKey: ["metadata", ns],
      queryFn: () => api<Metadata>(`/v1/namespaces/${ns}/metadata`),
      refetchInterval: 3000,
    })),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <h1>Namespaces</h1>
      <p className="mt-1 max-w-2xl text-muted">
        Each namespace is a prefix in the bucket, <Code>ns/&lt;name&gt;/</Code>, created by its first write. Nothing
        about it lives on a node: any query node can serve any namespace.
      </p>

      <div className="mt-6">
        <ErrorNote error={list.error} />
        {list.data && names.length === 0 && (
          <Empty title="No namespaces yet">
            Write a document to create one. <Code>make load</Code> writes 50,000 test documents to <Code>load-test</Code>.
          </Empty>
        )}
        {names.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-left text-[13.5px]">
              <thead className="border-b border-line text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 text-right font-medium">Documents</th>
                  <th className="px-4 py-2.5 text-right font-medium">Size</th>
                  <th className="px-4 py-2.5 font-medium">Index</th>
                  <th className="px-4 py-2.5 font-medium">Vectors</th>
                </tr>
              </thead>
              <tbody>
                {names.map((ns, i) => {
                  const m = metas[i]?.data;
                  return (
                    <tr key={ns} className="border-b border-line last:border-0 hover:bg-surface-2">
                      <td className="px-4 py-2.5">
                        <Link to={`/ns/${encodeURIComponent(ns)}`} className="font-mono font-medium text-accent hover:underline">{ns}</Link>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right">{m ? fmtNum(m.approx_row_count) : "…"}</td>
                      <td className="tabular px-4 py-2.5 text-right text-muted">{m ? fmtBytes(m.approx_logical_bytes) : "…"}</td>
                      <td className="px-4 py-2.5">{m && <IndexStatus status={m.index.status} rows={m.index.unindexed_rows} />}</td>
                      <td className="px-4 py-2.5 text-muted">{m?.dims ? `${m.dims} dims, ${m.distance_metric}` : m ? "None" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
