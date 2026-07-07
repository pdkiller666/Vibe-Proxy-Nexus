import { X } from "lucide-react";
import { useOnboarding } from "@/hooks/use-onboarding";

interface OnboardingTipProps {
  id: string;
  icon?: React.ReactNode;
  title: string;
  children: React.ReactNode;
}

export function OnboardingTip({ id, icon, title, children }: OnboardingTipProps) {
  const { isVisible, dismiss } = useOnboarding();
  if (!isVisible(id)) return null;

  return (
    <div className="relative bg-orange-50 border border-orange-200 p-4 pr-10 animate-in fade-in slide-in-from-top-1 duration-300">
      <button
        onClick={() => dismiss(id)}
        className="absolute top-3 right-3 text-orange-300 hover:text-orange-600 transition-colors"
        title="Закрыть подсказку"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-start gap-3">
        {icon && <div className="shrink-0 mt-0.5 text-orange-500">{icon}</div>}
        <div className="text-sm">
          <p className="font-semibold text-orange-900 mb-1">{title}</p>
          <div className="text-orange-800 leading-relaxed space-y-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
