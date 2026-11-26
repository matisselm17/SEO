/**
 * Import Search Console : .zip « Performances » en français et en anglais, .csv seul, nombres localisés.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { importFile, parseCsv, parseDate, parseNumber, totalsOf } from "../src/gsc/import.ts";
import { HttpError } from "../src/errors.ts";

const NNBSP = " ";

export const FR_FILES: Record<string, string> = {
  "Requêtes.csv": `﻿Requêtes les plus fréquentes,Clics,Impressions,CTR,Position
atelier lune,410,980,"41,84 %","1,2"
cours de poterie nantes,190,"7${NNBSP}400","2,57 %","8,7"
"vaisselle grès, artisanale",12,"1${NNBSP}234","0,97 %","14,3"
`,
  "Pages.csv": `Pages les plus populaires,Clics,Impressions,CTR,Position
https://www.atelier-lune.example/,640,"12${NNBSP}800","5 %","6,1"
https://atelier-lune.example/boutique/,212,"9${NNBSP}040","2,35 %","14,2"
https://atelier-lune.example/blog/emaillage,12,900,"1,33 %","22,5"
`,
  "Dates.csv": `Date,Clics,Impressions,CTR,Position
2026-11-25,27,764,"3,53 %","17,9"
2026-11-23,22,701,"3,14 %","18,8"
2026-11-24,31,812,"3,82 %","18,1"
`,
  "Pays.csv": `Pays,Clics,Impressions,CTR,Position
France,800,20000,"4 %","12"
`,
  "Filtres.csv": `Filtre,Valeur
Type de recherche,Web
Date,3 derniers mois
`,
};

export const EN_FILES: Record<string, string> = {
  "Queries.csv": `Top queries,Clicks,Impressions,CTR,Position
atelier lune,410,980,41.84%,1.2
pottery classes nantes,"1,190","17,400",6.84%,8.7
`,
  "Pages.csv": `Top pages,Clicks,Impressions,CTR,Position
https://atelier-lune.example/,640,"12,800",5%,6.1
`,
  "Dates.csv": `Date,Clicks,Impressions,CTR,Position
2026-11-24,31,812,3.82%,18.1
2026-11-25,27,764,3.53%,17.9
`,
  "Devices.csv": `Device,Clicks,Impressions,CTR,Position
Mobile,10,100,10%,3
`,
};

export function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([n, t]) => [n, strToU8(t)])));
}

test("nombres au format français et anglais", () => {
  assert.equal(parseNumber(`1${NNBSP}234,5`, "fr"), 1234.5);
  assert.equal(parseNumber("1 234", "fr"), 1234);
  assert.equal(parseNumber("3,01 %", "fr"), 0.0301);
  assert.equal(parseNumber("8,7", "fr"), 8.7);
  assert.equal(parseNumber("1,234.5", "en"), 1234.5);
  assert.equal(parseNumber("1,234", "en"), 1234);
  assert.equal(parseNumber("3.01%", "en"), 0.0301);
  assert.equal(parseNumber("", "fr"), null);
  assert.equal(parseDate("2026-11-25", "fr"), "2026-11-25");
  assert.equal(parseDate("25/11/2026", "fr"), "2026-11-25");
  assert.equal(parseDate("11/25/2026", "en"), "2026-11-25");
});

test("CSV : guillemets, virgules dans un champ, point-virgule", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(parseCsv("a;b\r\n1;2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("zip français complet", () => {
  const data = importFile("export.zip", zipOf(FR_FILES));
  assert.equal(data.queries?.length, 3);
  assert.deepEqual(data.queries?.[0], { query: "atelier lune", clicks: 410, impressions: 980, ctr: 0.4184, position: 1.2 });
  assert.equal(data.queries?.[2].query, "vaisselle grès, artisanale");
  assert.equal(data.queries?.[1].impressions, 7400);
  assert.equal(data.pages?.length, 3);
  assert.equal(data.pages?.[0].url, "https://www.atelier-lune.example/");
  assert.equal(data.pages?.[0].ctr, 0.05);
  assert.deepEqual(data.series?.map((p) => p.date), ["2026-11-23", "2026-11-24", "2026-11-25"]);
  assert.deepEqual(data.period, { start: "2026-11-23", end: "2026-11-25" });
  const t = totalsOf(data);
  assert.equal(t.clicks, 80);
  assert.equal(t.impressions, 2277);
  assert.equal(t.ctr, Math.round((80 / 2277) * 10000) / 10000);
  assert.ok(t.position > 17 && t.position < 19);
});

test("zip anglais", () => {
  const data = importFile("Performance-on-Search.zip", zipOf(EN_FILES));
  assert.equal(data.queries?.[0].query, "pottery classes nantes");
  assert.equal(data.queries?.[0].clicks, 1190);
  assert.equal(data.queries?.[0].impressions, 17400);
  assert.equal(data.pages?.[0].impressions, 12800);
  assert.equal(data.series?.length, 2);
});

test("csv seul : requêtes uniquement, totaux par somme des requêtes", () => {
  const data = importFile("Requêtes.csv", strToU8(FR_FILES["Requêtes.csv"]));
  assert.equal(data.pages, null);
  assert.equal(data.series, null);
  assert.equal(data.period, null);
  assert.equal(totalsOf(data).clicks, 612);
});

test("fichier illisible, archive sans CSV, fichier trop gros", () => {
  const expectCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof HttpError && e.code === code);
  expectCode(() => importFile("x.csv", strToU8("nom,prenom\nDupont,Jean\n")), "invalid_file");
  expectCode(() => importFile("x.zip", zipSync({ "a.txt": strToU8("bonjour") })), "invalid_file");
  expectCode(() => importFile("x.zip", new Uint8Array([0x50, 0x4b, 1, 2, 3, 4, 5])), "invalid_file");
  expectCode(() => importFile("x.csv", new Uint8Array(21 * 1024 * 1024)), "file_too_large");
});

test("entrée d'archive trop grosse : message exact ; adresses d'un autre site écartées", () => {
  const big = zipSync({ "Requêtes.csv": new Uint8Array(41 * 1024 * 1024).fill(65) });
  assert.throws(
    () => importFile("x.zip", big),
    (e: unknown) => e instanceof HttpError && e.code === "invalid_file" && e.message === "Le fichier « Requêtes.csv » de l'archive dépasse 40 Mo une fois décompressé.",
  );
  const data = importFile("export.zip", zipOf(FR_FILES), "atelier-lune.example");
  assert.equal(data.pages?.length, 3);
  assert.throws(() => importFile("export.zip", zipOf(FR_FILES), "autre-site.fr"), (e: unknown) => e instanceof HttpError && /autre site \(atelier-lune\.example\)/.test(e.message));
});
