import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyTickets,
  useGetTicket,
  useCreateSupportTicket,
  useAddTicketMessage,
  getListMyTicketsQueryKey,
  getGetTicketQueryKey,
} from "@workspace/api-client-react";
import type { SupportTicket } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageCircle, Plus, ArrowLeft, Send, ChevronDown, ChevronUp } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";

type TicketStatus = "open" | "answered" | "closed";

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Открыт",
  answered: "Ожидает вас",
  closed: "Закрыт",
};
const STATUS_CLS: Record<TicketStatus, string> = {
  open: "bg-blue-50 text-blue-700 border border-blue-200",
  answered: "bg-orange-50 text-orange-700 border border-orange-200",
  closed: "bg-gray-100 text-gray-500 border border-gray-200",
};

const FAQ = [
  {
    q: "Как подключиться на iPhone/Android?",
    a: "Установите приложение Happ (iOS/Android) или v2rayNG (Android). В разделе «Ключи VPN» скопируйте ссылку или отсканируйте QR-код — приложение добавит профиль автоматически.",
  },
  {
    q: "Почему подключение медленное?",
    a: "Проверьте: 1) сигнал Wi-Fi или мобильного интернета, 2) что выбран ближайший узел. Если проблема сохраняется — создайте тикет, укажите скорость до и после подключения.",
  },
  {
    q: "Как подключить второе устройство?",
    a: "В разделе «Ключи VPN» нажмите «Добавить устройство». Количество устройств зависит от тарифа. Если устройства закончились — можно докупить дополнительное устройство в разделе «Тарифы».",
  },
  {
    q: "Что делать, если VPN не работает после обновления приложения?",
    a: "Удалите профиль из VPN-клиента и добавьте заново, скопировав актуальную ссылку из личного кабинета. Ключи периодически обновляются для безопасности.",
  },
  {
    q: "Как отменить или продлить подписку?",
    a: "Подписка не продлевается автоматически. Когда она истечёт, перейдите в «Тарифы» и выберите нужный план. Оплата — вручную через СБП по реквизитам.",
  },
  {
    q: "Безопасно ли использовать VPNexus?",
    a: "Да. Мы не храним логи трафика. Каждый пользователь получает уникальный ключ. Протокол VLESS + WebSocket шифрует соединение и маскирует его под обычный HTTPS.",
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        className="w-full flex items-center justify-between py-4 text-left gap-4 hover:text-orange-600 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-medium text-sm text-gray-800">{q}</span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-orange-500 shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
        )}
      </button>
      {open && <p className="text-sm text-gray-500 pb-4 leading-relaxed">{a}</p>}
    </div>
  );
}

function TicketThread({ ticketId, onBack }: { ticketId: number; onBack: () => void }) {
  const [reply, setReply] = useState("");
  const { data: ticket, isLoading } = useGetTicket(ticketId);
  const { mutate: addMessage, isPending } = useAddTicketMessage();
  const qc = useQueryClient();
  const { toast } = useToast();

  function send() {
    const body = reply.trim();
    if (!body) return;
    addMessage(
      { ticketId, data: { body } },
      {
        onSuccess: () => {
          setReply("");
          qc.invalidateQueries({ queryKey: getGetTicketQueryKey(ticketId) });
          qc.invalidateQueries({ queryKey: getListMyTicketsQueryKey() });
        },
        onError: () => toast({ title: "Ошибка", description: "Не удалось отправить сообщение", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="flex flex-col h-full">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 transition-colors mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Все обращения
      </button>

      {isLoading || !ticket ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3 mb-5 pb-4 border-b border-gray-100">
            <div>
              <h2 className="font-bold text-base text-gray-900">{ticket.subject}</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                #{ticket.id} · {new Date(ticket.createdAt).toLocaleDateString("ru-RU")}
              </p>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 whitespace-nowrap ${STATUS_CLS[ticket.status as TicketStatus]}`}>
              {STATUS_LABEL[ticket.status as TicketStatus]}
            </span>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto mb-4 max-h-[40vh] pr-1">
            {ticket.messages.map((msg) => (
              <div
                key={msg.id}
                className={`p-3.5 text-sm leading-relaxed ${
                  msg.isAdmin
                    ? "bg-orange-50 border border-orange-100 ml-4"
                    : "bg-gray-50 border border-gray-100 mr-4"
                }`}
              >
                <p className="text-gray-800 whitespace-pre-wrap">{msg.body}</p>
                <p className="text-xs text-gray-400 mt-1.5">
                  {msg.isAdmin ? "Поддержка" : "Вы"} ·{" "}
                  {new Date(msg.createdAt).toLocaleString("ru-RU", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </p>
              </div>
            ))}
          </div>

          {ticket.status !== "closed" ? (
            <div className="border-t border-gray-100 pt-4 space-y-3">
              <Textarea
                placeholder="Напишите ответ…"
                className="resize-none rounded-none text-sm"
                rows={3}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
                }}
              />
              <button
                onClick={send}
                disabled={isPending || !reply.trim()}
                className="flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white text-sm font-bold px-5 py-2.5 transition-colors disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {isPending ? "Отправка…" : "Отправить"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-400 border-t border-gray-100 pt-4">
              Тикет закрыт. Создайте новое обращение, если вопрос не решён.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function NewTicketForm({ onCreated }: { onCreated: (id: number) => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const { mutate: create, isPending } = useCreateSupportTicket();
  const qc = useQueryClient();
  const { toast } = useToast();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) return;
    create(
      { data: { subject: subject.trim(), body: body.trim() } },
      {
        onSuccess: (ticket) => {
          qc.invalidateQueries({ queryKey: getListMyTicketsQueryKey() });
          onCreated(ticket.id);
        },
        onError: () => toast({ title: "Ошибка", description: "Не удалось создать обращение", variant: "destructive" }),
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="text-xs font-semibold text-gray-600 uppercase tracking-wider block mb-1.5">
          Тема обращения
        </label>
        <Input
          placeholder="Кратко опишите проблему"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
          className="rounded-none"
          required
        />
      </div>
      <div>
        <label className="text-xs font-semibold text-gray-600 uppercase tracking-wider block mb-1.5">
          Описание
        </label>
        <Textarea
          placeholder="Подробно опишите ситуацию: что сделали, что произошло, какое устройство используете…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          className="resize-none rounded-none"
          rows={5}
          required
        />
        <p className="text-xs text-gray-400 mt-1">{body.length}/4000</p>
      </div>
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending || !subject.trim() || !body.trim()}
          className="bg-orange-600 hover:bg-orange-700 text-white text-sm font-bold px-6 py-2.5 transition-colors disabled:opacity-50"
        >
          {isPending ? "Создание…" : "Создать обращение"}
        </button>
      </div>
    </form>
  );
}

export default function SupportPage() {
  const [view, setView] = useState<"list" | "new" | number>("list");
  const { data: tickets, isLoading } = useListMyTickets();

  const openCount = tickets?.filter((t) => t.status === "open" || t.status === "answered").length ?? 0;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Поддержка</h1>
          <p className="text-sm text-gray-500 mt-0.5">Задайте вопрос или сообщите о проблеме</p>
        </div>
        {view !== "new" && (
          <button
            onClick={() => setView("new")}
            className="flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white text-sm font-bold px-4 py-2.5 transition-colors"
          >
            <Plus className="w-4 h-4" /> Новое обращение
          </button>
        )}
      </div>

      <OnboardingTip
        id="support-intro"
        icon={<MessageCircle className="w-4 h-4" />}
        title="Как работает поддержка"
      >
        <p>Создайте обращение — опишите проблему или задайте вопрос. Отвечаем обычно в течение нескольких часов.</p>
        <p>В разделе <strong>FAQ</strong> ниже собраны ответы на самые частые вопросы — возможно, ответ уже там.</p>
      </OnboardingTip>

      {/* Main content */}
      {view === "new" ? (
        <div className="bg-white border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold text-base">Новое обращение</h2>
            <button
              onClick={() => setView("list")}
              className="text-sm text-gray-400 hover:text-gray-700 transition-colors flex items-center gap-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Назад
            </button>
          </div>
          <NewTicketForm onCreated={(id) => setView(id)} />
        </div>
      ) : typeof view === "number" ? (
        <div className="bg-white border border-gray-200 p-6">
          <TicketThread ticketId={view} onBack={() => setView("list")} />
        </div>
      ) : (
        <>
          {/* Ticket list */}
          <div className="bg-white border border-gray-200">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <span className="font-semibold text-sm text-gray-700 flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-orange-500" />
                Мои обращения
              </span>
              {openCount > 0 && (
                <span className="text-xs font-bold bg-orange-100 text-orange-700 px-2 py-0.5">
                  {openCount} активных
                </span>
              )}
            </div>

            {isLoading ? (
              <div className="p-5 space-y-3">
                {[1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : !tickets?.length ? (
              <div className="py-12 text-center text-sm text-gray-400">
                <MessageCircle className="w-8 h-8 mx-auto mb-3 text-gray-200" />
                Обращений пока нет. Создайте первое!
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {tickets.map((t: SupportTicket) => (
                  <button
                    key={t.id}
                    onClick={() => setView(t.id)}
                    className="w-full text-left px-5 py-4 hover:bg-gray-50 transition-colors flex items-start justify-between gap-4 group"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm text-gray-900 truncate group-hover:text-orange-600 transition-colors">
                        {t.subject}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        #{t.id} · {new Date(t.updatedAt).toLocaleDateString("ru-RU")} · {t.messageCount} сообщ.
                      </p>
                    </div>
                    <span className={`text-xs font-semibold px-2.5 py-1 shrink-0 ${STATUS_CLS[t.status as TicketStatus]}`}>
                      {STATUS_LABEL[t.status as TicketStatus]}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* FAQ */}
      <div className="bg-white border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-sm text-gray-700">Частые вопросы</h2>
        </div>
        <div className="px-5">
          {FAQ.map((item) => (
            <FaqItem key={item.q} {...item} />
          ))}
        </div>
      </div>
    </div>
  );
}
