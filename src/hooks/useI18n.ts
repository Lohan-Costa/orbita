import { useAppStore } from "../store/appStore";
import ptBR from "../i18n/pt-BR.json";
import en from "../i18n/en.json";

const dicts = { "pt-BR": ptBR, en } as const;

export type Dict = typeof ptBR;

export function useI18n(): Dict {
  const locale = useAppStore((s) => s.locale);
  return dicts[locale] ?? ptBR;
}
