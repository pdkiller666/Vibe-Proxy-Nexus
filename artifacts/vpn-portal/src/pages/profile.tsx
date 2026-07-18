import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useUpdateMe, useChangeMyEmail, useChangeMyPassword, getGetMeQueryKey } from "@workspace/api-client-react";
import { UserCircle, Mail, KeyRound, Save, Users, Copy, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function NameSection() {
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(me?.name ?? "");
  const [dirty, setDirty] = useState(false);

  const { mutate, isPending } = useUpdateMe({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setDirty(false);
        toast({ title: "Имя обновлено" });
      },
      onError: (err) => toast({ title: errorMessage(err, "Не удалось обновить имя"), variant: "destructive" }),
    },
  });

  return (
    <div className="bg-card border border-border p-5 space-y-4">
      <div className="flex items-center gap-2">
        <UserCircle className="w-4 h-4 text-primary" />
        <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Имя</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Input
          value={dirty ? name : (me?.name ?? name)}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          placeholder="Ваше имя"
          className="rounded-none max-w-sm"
        />
        <button
          onClick={() => mutate({ data: { name: name.trim() || null } })}
          disabled={isPending || !dirty}
          className="flex items-center gap-1.5 bg-primary text-primary-foreground font-bold px-5 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {isPending ? "Сохраняем..." : "Сохранить"}
        </button>
      </div>
    </div>
  );
}

function EmailSection() {
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");

  const { mutate, isPending } = useChangeMyEmail({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setNewEmail("");
        setCurrentPassword("");
        toast({ title: "Email изменён" });
      },
      onError: (err) => toast({ title: errorMessage(err, "Не удалось изменить email"), variant: "destructive" }),
    },
  });

  return (
    <div className="bg-card border border-border p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Mail className="w-4 h-4 text-primary" />
        <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Email для входа</p>
      </div>
      <p className="text-sm text-muted-foreground">
        Текущий: <span className="font-mono text-foreground">{me?.email}</span>
      </p>
      <div className="grid sm:grid-cols-2 gap-2 max-w-lg">
        <Input
          type="email"
          placeholder="Новый email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          className="rounded-none"
        />
        <Input
          type="password"
          placeholder="Текущий пароль"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="rounded-none"
        />
      </div>
      <button
        onClick={() => mutate({ data: { newEmail, currentPassword } })}
        disabled={isPending || !newEmail || !currentPassword}
        className="bg-primary text-primary-foreground font-bold px-5 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {isPending ? "Сохраняем..." : "Изменить email"}
      </button>
    </div>
  );
}

function PasswordSection() {
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const { mutate, isPending } = useChangeMyPassword({
    mutation: {
      onSuccess: () => {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        toast({ title: "Пароль изменён" });
      },
      onError: (err) => toast({ title: errorMessage(err, "Не удалось изменить пароль"), variant: "destructive" }),
    },
  });

  const mismatch = newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword;

  return (
    <div className="bg-card border border-border p-5 space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-primary" />
        <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Пароль</p>
      </div>
      <div className="grid sm:grid-cols-3 gap-2 max-w-2xl">
        <Input
          type="password"
          placeholder="Текущий пароль"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="rounded-none"
        />
        <Input
          type="password"
          placeholder="Новый пароль"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="rounded-none"
        />
        <Input
          type="password"
          placeholder="Повторите новый пароль"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="rounded-none"
        />
      </div>
      {mismatch && <p className="text-sm text-destructive">Пароли не совпадают</p>}
      <button
        onClick={() => mutate({ data: { currentPassword, newPassword } })}
        disabled={isPending || !currentPassword || newPassword.length < 8 || mismatch}
        className="bg-primary text-primary-foreground font-bold px-5 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {isPending ? "Сохраняем..." : "Изменить пароль"}
      </button>
      <p className="text-xs text-muted-foreground">
        Минимум 8 символов. После смены пароля все остальные ваши сеансы входа будут завершены.
      </p>
    </div>
  );
}

function ReferralSection() {
  const { data: me } = useGetMe();
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  if (!me?.referralCode) return null;

  // Use the backend-resolved host (admin's configured primary domain, or the
  // technical domain as a safety-net fallback) instead of window.location —
  // otherwise a user browsing via the technical Amvera URL would share links
  // pointing at that hidden domain instead of the public one.
  const referralLink = `https://${me.referralLinkHost}${basePath}/sign-up?ref=${me.referralCode}`;

  function handleCopy() {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleCopyCode() {
    if (!me) return;
    navigator.clipboard.writeText(me.referralCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  }

  return (
    <div className="bg-card border border-border p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-primary" />
        <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
          Реферальная программа
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Проект доступен только по приглашениям. Поделитесь своей ссылкой — за каждую оплаченную подписку
        приглашённого пользователя вам начисляется{" "}
        <span className="text-foreground font-bold">{me.referralCommissionPercent}%</span> от суммы на баланс.
      </p>
      <div className="flex gap-2 flex-wrap">
        <Input value={referralLink} readOnly className="rounded-none max-w-lg font-mono text-xs" />
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 bg-primary text-primary-foreground font-bold px-5 py-2 text-sm hover:opacity-90 transition-opacity"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? "Скопировано" : "Скопировать"}
        </button>
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-muted-foreground whitespace-nowrap">Инвайт-код:</span>
          <Input
            value={me.referralCode}
            readOnly
            className="rounded-none w-36 font-mono text-sm tracking-widest text-center"
          />
        </div>
        <button
          onClick={handleCopyCode}
          className="flex items-center gap-1.5 bg-primary text-primary-foreground font-bold px-5 py-2 text-sm hover:opacity-90 transition-opacity"
        >
          {copiedCode ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copiedCode ? "Скопировано" : "Скопировать"}
        </button>
      </div>
      <div className="flex gap-6 flex-wrap text-sm pt-1">
        <div>
          <span className="text-muted-foreground">Приглашено: </span>
          <span className="font-bold">{me.referredUserCount}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Заработано: </span>
          <span className="font-bold">{(me.referralEarningsKopecks / 100).toFixed(2)} ₽</span>
        </div>
      </div>
    </div>
  );
}

export default function Profile() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Профиль</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Управляйте своими учётными данными.
        </p>
      </div>

      <NameSection />
      <EmailSection />
      <PasswordSection />
      <ReferralSection />
    </div>
  );
}
