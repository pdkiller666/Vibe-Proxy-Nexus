import { useMemo, useState } from "react";
import {
  getGetVpnNodeTrafficQueryKey,
  useGetVpnNodeTraffic,
} from "@workspace/api-client-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LineChart as LineChartIcon, X } from "lucide-react";

export type TrafficSource = "interface" | "xray";

function formatTrafficBytes(bytes: number): string {
  if (!bytes) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function NodeTrafficHistoryPanel({
  nodeId,
  source,
  onClose,
}: {
  nodeId: number;
  source: TrafficSource;
  onClose: () => void;
}) {
  type Period = "7d" | "30d" | "90d" | "custom";
  const [period, setPeriod] = useState<Period>("30d");
  const todayStr = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const sevenDaysAgoStr = useMemo(() => new Date(Date.now() - 7 * 86400_000).toLocaleDateString("en-CA"), []);
  const [customFrom, setCustomFrom] = useState(sevenDaysAgoStr);
  const [customTo, setCustomTo] = useState(todayStr);

  const { from, to } = useMemo(() => {
    const now = new Date();
    if (period === "7d") return { from: new Date(now.getTime() - 7 * 86400_000).toISOString(), to: now.toISOString() };
    if (period === "30d") return { from: new Date(now.getTime() - 30 * 86400_000).toISOString(), to: now.toISOString() };
    if (period === "90d") return { from: new Date(now.getTime() - 90 * 86400_000).toISOString(), to: now.toISOString() };
    return {
      from: customFrom ? new Date(`${customFrom}T00:00:00.000Z`).toISOString() : new Date(now.getTime() - 30 * 86400_000).toISOString(),
      to: customTo ? new Date(`${customTo}T23:59:59.999Z`).toISOString() : now.toISOString(),
    };
  }, [period, customFrom, customTo]);

  const { data, isLoading, error } = useGetVpnNodeTraffic(
    nodeId,
    { source, from, to },
    {
      query: {
        queryKey: getGetVpnNodeTrafficQueryKey(nodeId, { source, from, to }),
        retry: false,
      },
    },
  );

  const points = data?.points ?? [];
  const chartPoints = points.map((point) => ({
    ...point,
    inMiB: point.inBytes / 1_048_576,
    outMiB: point.outBytes / 1_048_576,
  }));
  const totalInBytes = points.reduce((sum, point) => sum + point.inBytes, 0);
  const totalOutBytes = points.reduce((sum, point) => sum + point.outBytes, 0);
  const rangeMs = new Date(to).getTime() - new Date(from).getTime();
  const shortRange = rangeMs <= 7 * 86400_000;
  const formatTick = (ts: number) => {
    const date = new Date(ts);
    return shortRange
      ? date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit" })
      : date.toLocaleString("ru-RU", { day: "2-digit", month: "short" });
  };
  const formatTooltipDate = (ts: number) =>
    new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  const labels = source === "interface"
    ? { inbound: "RX", outbound: "TX" }
    : { inbound: "От клиента", outbound: "К клиенту" };
  const title = source === "interface" ? "Сетевой интерфейс" : "VPN-трафик Xray";
  const colorIn = source === "interface" ? "#06b6d4" : "#8b5cf6";
  const colorOut = source === "interface" ? "#0ea5e9" : "#ec4899";

  return (
    <div className="mt-3 border border-border bg-background">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <span className="text-xs font-bold uppercase tracking-wide flex items-center gap-1.5" data-testid="text-traffic-history-title">
          <LineChartIcon className="w-3.5 h-3.5" />
          {title} — история
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-1 transition-colors"
          title="Закрыть"
          data-testid="button-close-traffic-history"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border flex-wrap">
        {(["7d", "30d", "90d"] as Period[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setPeriod(value)}
            className={`px-2.5 py-0.5 text-xs border transition-colors ${period === value ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"}`}
            data-testid={`button-traffic-period-${value}`}
          >
            {value === "7d" ? "7 дней" : value === "30d" ? "30 дней" : "90 дней"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPeriod("custom")}
          className={`px-2.5 py-0.5 text-xs border transition-colors ${period === "custom" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"}`}
          data-testid="button-traffic-period-custom"
        >
          Произвольный
        </button>
        {period === "custom" && (
          <div className="flex items-center gap-1.5 mt-1 w-full">
            <input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="border border-border bg-background text-xs px-2 py-0.5 flex-1 min-w-0"
              aria-label="Начало периода"
              data-testid="input-traffic-from"
            />
            <span className="text-xs text-muted-foreground shrink-0">—</span>
            <input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              className="border border-border bg-background text-xs px-2 py-0.5 flex-1 min-w-0"
              aria-label="Конец периода"
              data-testid="input-traffic-to"
            />
          </div>
        )}
      </div>
      <div className="px-2 py-3">
        {isLoading ? (
          <div className="h-36 flex items-center justify-center text-xs text-muted-foreground" data-testid="status-traffic-history-loading">Загрузка…</div>
        ) : error ? (
          <div className="h-36 flex items-center justify-center text-xs text-destructive" data-testid="status-traffic-history-error">Не удалось загрузить историю трафика</div>
        ) : points.length === 0 ? (
          <div className="h-36 flex flex-col items-center justify-center gap-1" data-testid="status-traffic-history-empty">
            <p className="text-xs font-medium text-muted-foreground">Данных пока нет</p>
            <p className="text-[10px] text-muted-foreground max-w-[260px] text-center">
              История накапливается с момента включения сбора трафика.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartPoints} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id={`traffic-in-${source}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="10%" stopColor={colorIn} stopOpacity={0.24} />
                  <stop offset="95%" stopColor={colorIn} stopOpacity={0} />
                </linearGradient>
                <linearGradient id={`traffic-out-${source}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="10%" stopColor={colorOut} stopOpacity={0.20} />
                  <stop offset="95%" stopColor={colorOut} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={formatTick} tick={{ fontSize: 9 }} stroke="var(--muted-foreground)" tickCount={5} />
              <YAxis tickFormatter={(value: number) => `${value.toFixed(1)} МБ`} tick={{ fontSize: 9 }} stroke="var(--muted-foreground)" width={48} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const point = payload[0]?.payload;
                  if (!point) return null;
                  return (
                    <div className="bg-background border border-border px-2 py-1 text-xs shadow-md">
                      <p className="text-muted-foreground">{formatTooltipDate(point.ts as number)}</p>
                      <p style={{ color: colorIn }}>{labels.inbound}: {Number(point.inMiB).toFixed(2)} МБ</p>
                      <p style={{ color: colorOut }}>{labels.outbound}: {Number(point.outMiB).toFixed(2)} МБ</p>
                    </div>
                  );
                }}
              />
              <Area type="monotone" dataKey="inMiB" name={labels.inbound} stroke={colorIn} strokeWidth={1.5} fill={`url(#traffic-in-${source})`} dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="outMiB" name={labels.outbound} stroke={colorOut} strokeWidth={1.5} fill={`url(#traffic-out-${source})`} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
        {points.length > 0 && (
          <p className="text-[9px] text-muted-foreground text-right mt-1 font-mono" data-testid="text-traffic-period-total">
            За период: {labels.inbound} {formatTrafficBytes(totalInBytes)} · {labels.outbound} {formatTrafficBytes(totalOutBytes)}
          </p>
        )}
      </div>
    </div>
  );
}