export interface ErrLoc {
  block?: string
  field?: string
}

export class ConfigError extends Error {
  code: string
  rawMessage: string
  loc?: ErrLoc
  constructor(code: string, message: string, opts?: { loc?: ErrLoc }) {
    super(`${code}: ${message}`)
    this.name = 'ConfigError'
    this.code = code
    this.rawMessage = message
    this.loc = opts?.loc
  }
}

export class InputError extends Error {
  code: string
  input: string
  constructor(code: string, input: string, message: string) {
    super(`${code} [${input}]: ${message}`)
    this.name = 'InputError'
    this.code = code
    this.input = input
  }
}

export class RunError extends Error {
  code: string
  loc?: ErrLoc
  constructor(code: string, message: string, opts?: { loc?: ErrLoc }) {
    super(`${code}: ${message}`)
    this.name = 'RunError'
    this.code = code
    this.loc = opts?.loc
  }
}
