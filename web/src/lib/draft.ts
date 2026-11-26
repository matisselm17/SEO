/** Question préparée depuis un autre écran, reprise par l'assistant à l'ouverture. */
const drafts = new Map<string, string>();
export const setDraft = (siteId: string, text: string) => drafts.set(siteId, text);
export function takeDraft(siteId: string): string | null {
  const d = drafts.get(siteId) ?? null;
  drafts.delete(siteId);
  return d;
}
