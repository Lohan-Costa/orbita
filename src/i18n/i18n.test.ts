/**
 * Os locales não podem divergir — e a divergência é SILENCIOSA.
 *
 * `pt-BR` é a base e `en` a espelha. Quando alguém acrescenta uma chave só na base, o
 * app em inglês não quebra: ele mostra `undefined`, ou o texto some. Ninguém percebe
 * até um usuário em inglês abrir a tela — que é tarde, e é como se perde a confiança.
 *
 * O objetivo declarado no CLAUDE.md é "traduzir para inglês depois sem quebrar nada".
 * Este arquivo é o que torna isso verificável em vez de intencional.
 */

import { describe, expect, it } from "vitest";
import ptBR from "./pt-BR.json";
import en from "./en.json";

type Tree = { [k: string]: string | Tree };

/** Achata a árvore em "sync.export" → "Exportar". */
function flat(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") out[prefix + k] = v;
    else Object.assign(out, flat(v, `${prefix}${k}.`));
  }
  return out;
}

const base = flat(ptBR as Tree);
const other = flat(en as Tree);

describe("locales", () => {
  it("en tem EXATAMENTE as chaves de pt-BR", () => {
    expect(Object.keys(other).sort()).toEqual(Object.keys(base).sort());
  });

  it("os placeholders {{x}} são os mesmos nos dois", () => {
    // Trocar `{{n}}` por `{{count}}` na tradução não quebra o build — só faz o número
    // sumir da tela, em inglês, em silêncio.
    const marks = (s: string) => (s.match(/{{(\w+)}}/g) ?? []).sort();

    for (const key of Object.keys(base)) {
      expect(marks(other[key]), `placeholders de "${key}"`).toEqual(marks(base[key]));
    }
  });

  it("nenhuma tradução em inglês ficou em português", () => {
    // Heurística grosseira, e é o suficiente: um valor "traduzido" por copiar e colar
    // do pt-BR quase sempre traz um acento junto. Exceção: nome próprio que não se
    // traduz — "Órbita" é o mesmo nos dois locales de propósito, não um esquecimento.
    // O acento do "Ó" aparece também no MEIO de valores em inglês legítimos (ex.:
    // "restart Órbita"), então tiramos a marca onde quer que ela apareça antes de
    // testar — senão a heurística flagra a própria marca do produto.
    const INTENTIONALLY_IDENTICAL = new Set(["app.title"]);
    const semMarca = (s: string) => s.replace(/Órbita/gi, "");
    const comAcento = Object.entries(other)
      .filter(([k, v]) => !INTENTIONALLY_IDENTICAL.has(k) && /[áàâãéêíóôõúç]/i.test(semMarca(v)))
      .map(([k]) => k);

    expect(comAcento).toEqual([]);
  });

  it("nenhum valor está vazio", () => {
    const vazias = Object.entries({ ...base, ...other })
      .filter(([, v]) => !v.trim())
      .map(([k]) => k);

    expect(vazias).toEqual([]);
  });
});
