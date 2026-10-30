// contract/validate.mts：BFF 共享契约的运行时校验器（无第三方依赖）。
// 支持 JSON Schema 子集：type（含类型数组，可含 'null'）、required、properties、
// additionalProperties:false、items、enum、pattern、minLength/maxLength、
// minimum/maximum、minItems/maxItems。同一子集直接嵌入 OpenAPI 3.1 文档（3.1 合法）。
// 与 fjsp-tools 2.A 的 validateValue 同风格但独立：那一层是工具入参契约，这一层是
// BFF HTTP/SSE 线协议契约，互不复用以避免跨层耦合。

export type Schema = {
  type?: string | string[]
  required?: string[]
  properties?: Record<string, Schema>
  additionalProperties?: boolean
  items?: Schema
  enum?: unknown[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

export type Issue = { path: string; message: string }

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value // 'string' | 'number' | 'boolean' | 'object' | 'undefined' | ...
}

function typeMatches(declared: string, value: unknown): boolean {
  const actual = typeOf(value)
  if (declared === 'integer') return actual === 'number' && Number.isInteger(value)
  return declared === actual
}

/** 按 schema 校验 value，返回问题列表（空数组 = 通过）。path 用 a.b[0] 风格定位。 */
export function validateValue(schema: Schema, value: unknown, path = ''): Issue[] {
  const issues: Issue[] = []
  const at = path || '(root)'
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    issues.push({ path: at, message: `取值必须是 ${schema.enum.map((e) => JSON.stringify(e)).join(' / ')}` })
    return issues
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => typeMatches(t, value))) {
      issues.push({ path: at, message: `类型应为 ${types.join(' | ')}，实际为 ${typeOf(value)}` })
      return issues // 类型不符时不再深入，避免级联噪声
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path: at, message: `长度至少 ${schema.minLength}` })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path: at, message: `长度最多 ${schema.maxLength}` })
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path: at, message: `需匹配 ${schema.pattern}` })
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path: at, message: `最小值 ${schema.minimum}` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path: at, message: `最大值 ${schema.maximum}` })
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path: at, message: `至少 ${schema.minItems} 项` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path: at, message: `最多 ${schema.maxItems} 项` })
    }
    if (schema.items) {
      value.forEach((item, i) => issues.push(...validateValue(schema.items!, item, `${at}[${i}]`)))
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) issues.push({ path: `${at}.${key}`, message: '缺少必填字段' })
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) issues.push(...validateValue(propSchema, obj[key], `${at}.${key}`))
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) issues.push({ path: `${at}.${key}`, message: '未知字段' })
      }
    }
  }
  return issues
}
