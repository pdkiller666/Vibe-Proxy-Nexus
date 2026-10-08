import { useState } from "react";
import {
  getGetAdminVpnNodeRealityIdentityQueryKey,
  useGetAdminVpnNodeRealityIdentity,
} from "@workspace/api-client-react";

type RealityNodeIdentityCheckProps = {
  nodeId: number;
};

export function RealityNodeIdentityCheck({ nodeId }: RealityNodeIdentityCheckProps) {
  const [requested, setRequested] = useState(false);
  const { data, error, isFetching, isLoading, refetch } = useGetAdminVpnNodeRealityIdentity(nodeId, {
    query: {
      enabled: requested,
      staleTime: 0,
      gcTime: 0,
      retry: false,
      queryKey: getGetAdminVpnNodeRealityIdentityQueryKey(nodeId),
    },
  });

  const check = () => {
    if (requested) {
      void refetch();
    } else {
      setRequested(true);
    }
  };

  return (
    <section className="mt-3 border-t border-border pt-3" aria-label="Сверка Reality-профиля">
      <button
        type="button"
        onClick={check}
        disabled={isFetching}
        data-testid={`reality-check-${nodeId}`}
        className="text-xs px-2 py-1 border border-border text-muted-foreground hover:text-primary hover:border-primary disabled:opacity-50"
      >
        {isFetching ? "Сверка…" : requested ? "Сверить Reality повторно" : "Сверить Reality"}
      </button>

      {requested && isLoading && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">Запрашиваю публичные параметры Xray…</p>
      )}
      {requested && error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          Не удалось получить состояние Reality. Проверьте доступность и Management API узла.
        </p>
      )}
      {data && (
        <div className="mt-3 space-y-2 text-xs">
          <p
            className={data.matches.all ? "font-semibold text-green-700 dark:text-green-400" : "font-semibold text-destructive"}
            role="status"
          >
            {data.matches.all
              ? "Профиль в админке совпадает с загруженным конфигом Xray."
              : "Профиль не совпадает с загруженным конфигом Xray."}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <IdentityValue
              label="Public Key"
              stored={data.stored.publicKey ?? "не задан"}
              live={data.live.publicKey}
              matches={data.matches.publicKey}
            />
            <IdentityValue
              label="Порт"
              stored={String(data.stored.port)}
              live={String(data.live.port)}
              matches={data.matches.port}
            />
            <IdentityValue
              label="SNI"
              stored={data.stored.sni}
              live={data.live.serverNames.join(", ") || "не задан"}
              matches={data.matches.sni}
            />
            <IdentityValue
              label="Short ID"
              stored={data.stored.shortId ?? "не задан"}
              live={data.live.shortIds.join(", ") || "не задан"}
              matches={data.matches.shortId}
            />
            <IdentityValue
              label="Транспорт / защита"
              stored={data.stored.transport}
              live={`${data.live.network} / ${data.live.security}`}
              matches={data.matches.transport}
            />
          </div>
          {data.live.dest && (
            <p className="break-all text-muted-foreground">
              Reality dest: <span className="font-mono">{data.live.dest}</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function IdentityValue({
  label,
  stored,
  live,
  matches,
}: {
  label: string;
  stored: string;
  live: string;
  matches: boolean;
}) {
  return (
    <div className="min-w-0 border border-border p-2">
      <div className="flex items-center justify-between gap-2 font-semibold">
        <span>{label}</span>
        <span className={matches ? "text-green-700 dark:text-green-400" : "text-destructive"}>
          {matches ? "Совпадает" : "Различается"}
        </span>
      </div>
      <div className="mt-1 break-all text-muted-foreground">
        <div>Админка: <span className="font-mono">{stored}</span></div>
        <div>Узел: <span className="font-mono">{live}</span></div>
      </div>
    </div>
  );
}
