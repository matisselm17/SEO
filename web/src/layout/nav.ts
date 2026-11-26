import { Bot, FileText, LayoutDashboard, Lightbulb, ListChecks, Settings, TrendingUp, Users, type LucideIcon } from "lucide-react";
import type { SectionName } from "../lib/router";

export const NAV: { id: SectionName; label: string; short: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Vue d'ensemble", short: "Vue d'ensemble", icon: LayoutDashboard },
  { id: "audit", label: "Audit SEO", short: "Audit", icon: ListChecks },
  { id: "pages", label: "Pages analysées", short: "Pages", icon: FileText },
  { id: "traffic", label: "Mots-clés et trafic organique", short: "Trafic", icon: TrendingUp },
  { id: "competitors", label: "Concurrents", short: "Concurrents", icon: Users },
  { id: "recommendations", label: "Recommandations", short: "Actions", icon: Lightbulb },
  { id: "assistant", label: "Assistant IA", short: "Assistant", icon: Bot },
  { id: "settings", label: "Paramètres", short: "Paramètres", icon: Settings },
];
