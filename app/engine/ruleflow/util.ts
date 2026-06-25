export function isAlpha(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}
export function isDigit(c: string): boolean { return c >= '0' && c <= '9' }
export function isAlphaNum(c: string): boolean { return isAlpha(c) || isDigit(c) }
export function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}
