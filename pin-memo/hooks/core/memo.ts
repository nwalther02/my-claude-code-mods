export type Memo = { id: number; text: string; checked: boolean | null }
export type MemoDocument = { version: 1; nextId: number; items: Memo[] }
export type CommandResult = { document: MemoDocument; changed: boolean; text: string }

export function emptyDocument(): MemoDocument { return { version: 1, nextId: 1, items: [] } }

export function cleanText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trim()
}

function content(raw: string): Pick<Memo, 'text' | 'checked'> {
  const clean = cleanText(raw)
  const match = /^(?:-\s+)?\[([ xX])\](?:\s+|$)([\s\S]*)$/.exec(clean)
  const text = (match ? match[2]! : clean).trim()
  if (!text) throw new Error('Enter the memo text. /pin help')
  if (Array.from(text).length > 2000) throw new Error('A memo can be at most 2,000 characters.')
  return { text, checked: match ? match[1]!.toLowerCase() === 'x' : null }
}

export function decodeDocument(value: unknown): MemoDocument {
  if (value === undefined) return emptyDocument()
  const bad = () => { throw new Error('The saved memos are not in a valid format. /pin clear resets them.') }
  if (!value || typeof value !== 'object') return bad()
  const v = value as Record<string, unknown>
  if (v.version !== 1 || !Number.isSafeInteger(v.nextId) || (v.nextId as number) < 1 || !Array.isArray(v.items) || v.items.length > 100) return bad()
  const ids = new Set<number>()
  const items: Memo[] = []
  for (const item of v.items) {
    if (!item || typeof item !== 'object') return bad()
    const m = item as Memo
    if (!Number.isSafeInteger(m.id) || m.id < 1 || m.id >= (v.nextId as number) || ids.has(m.id)
      || typeof m.text !== 'string' || !m.text || cleanText(m.text) !== m.text || Array.from(m.text).length > 2000
      || (m.checked !== null && typeof m.checked !== 'boolean')) return bad()
    ids.add(m.id)
    items.push({ id: m.id, text: m.text, checked: m.checked })
  }
  return { version: 1, nextId: v.nextId as number, items }
}

export const HELP = '/pin <memo> | /pin - [ ] <todo>\n/pin add <memo> | list | help\n/pin toggle|check|uncheck|remove <id>\n/pin edit <id> <memo> | clear'
export function listText(doc: MemoDocument): string {
  return doc.items.length ? doc.items.map(m => `${m.id} ${m.checked === null ? '·' : m.checked ? '[x]' : '[ ]'} ${m.text}`).join('\n') : 'No pinned memos. /pin <memo>'
}

export function execute(doc: MemoDocument, args: string): CommandResult {
  const raw = args.trim()
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
  const command = match?.[1] ?? 'list'
  const rest = match?.[2] ?? ''
  const unchanged = (text: string): CommandResult => ({ document: doc, changed: false, text })
  if (command === 'help' || command === 'list') {
    if (rest) throw new Error(HELP)
    return unchanged(command === 'help' ? HELP : listText(doc))
  }
  if (command === 'clear') {
    if (rest) throw new Error(HELP)
    return { document: { ...doc, items: [] }, changed: doc.items.length > 0, text: 'Cleared all pinned memos.' }
  }
  if (['toggle', 'check', 'uncheck', 'remove', 'edit'].includes(command)) {
    const idMatch = /^(\d+)(?:\s+([\s\S]*))?$/.exec(rest)
    if (!idMatch || (command !== 'edit' && idMatch[2]) || (command === 'edit' && !idMatch[2])) throw new Error(HELP)
    const id = Number(idMatch[1])
    const item = doc.items.find(m => m.id === id)
    if (!item) throw new Error(`Memo #${id} does not exist.`)
    if (command === 'remove') return { document: { ...doc, items: doc.items.filter(m => m.id !== id) }, changed: true, text: `Removed memo #${id}` }
    if (command !== 'edit' && item.checked === null) throw new Error('A plain memo has no check state. Use /pin edit to turn it into a todo.')
    const updated = command === 'edit' ? { ...item, ...content(idMatch[2]!) }
      : { ...item, checked: command === 'toggle' ? !item.checked : command === 'check' }
    if (updated.text === item.text && updated.checked === item.checked) return unchanged(`Memo #${id} unchanged`)
    return { document: { ...doc, items: doc.items.map(m => m.id === id ? updated : m) }, changed: true, text: `Updated memo #${id}` }
  }
  const memo = content(command === 'add' ? rest : raw)
  if (doc.items.length >= 100) throw new Error('You can pin at most 100 memos.')
  if (doc.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('The memo number limit has been reached.')
  return { document: { ...doc, nextId: doc.nextId + 1, items: [...doc.items, { id: doc.nextId, ...memo }] }, changed: true, text: `Pinned memo #${doc.nextId}` }
}
