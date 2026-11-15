// 离线验证（不依赖真实 React —— 它只存在于前端产物里，磁盘上没有安装）。
//
// 自带一个最小 React 桩：实现 createElement / memo / useState / useRef /
// useMemo / useEffect / useCallback / createPortal，并把元素树序列化成字符串。
// 目的是验证三件事：
//   1. 插件能被模块加载器收下，apply() 注册到正确的槽、正确的 id/priority/locale；
//   2. 组件在各种快照下都能渲染完成、不抛错；
//   3. Hook 调用序列在「渲染 / 不渲染」两种分支下完全一致（Hook 顺序违规会在这里炸）。
import { pathToFileURL } from 'node:url'

// ---- 最小 React 桩 -------------------------------------------------------
const HOOK_LOG = []

function createElement(type, props, ...children) {
  const flat = []
  const push = (c) => {
    if (c === null || c === undefined || c === false || c === true) return
    if (Array.isArray(c)) {
      c.forEach(push)
      return
    }
    flat.push(c)
  }
  push(children)
  return { $$el: true, type, props: props ?? {}, children: flat }
}

const Fragment = Symbol('Fragment')

function memo(fn) {
  const wrapped = (props) => fn(props)
  wrapped.$$memo = true
  return wrapped
}

function useState(initial) {
  const value = typeof initial === 'function' ? initial() : initial
  HOOK_LOG.push(['useState', value])
  return [value, () => {}]
}

function useRef(initial) {
  HOOK_LOG.push(['useRef'])
  return { current: initial }
}

function useMemo(factory, deps) {
  HOOK_LOG.push(['useMemo', deps])
  return factory()
}

function useCallback(fn, deps) {
  HOOK_LOG.push(['useCallback', deps])
  return fn
}

function useEffect(effect, deps) {
  HOOK_LOG.push(['useEffect', deps])
  return undefined
}

const React = { createElement, memo, useState, useRef, useMemo, useCallback, useEffect, Fragment }

const ReactDOM = {
  createPortal(node, container) {
    return { $$portal: true, node, container }
  },
}

// ---- 序列化 --------------------------------------------------------------
function renderNode(node, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => renderNode(n, depth)).join('')
  if (node.$$portal) return renderNode(node.node, depth)
  if (!node.$$el) return ''
  const { type, props, children } = node
  if (type === Fragment) return children.map((c) => renderNode(c, depth)).join('')
  if (typeof type === 'function') return renderNode(type(props), depth)
  if (typeof type !== 'string') return ''
  const attrs = []
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'ref' || k === 'key' || typeof v === 'function' || typeof v === 'object') continue
    attrs.push(`${k}="${String(v)}"`)
  }
  const inner = children.map((c) => renderNode(c, depth + 1)).join('')
  return `<${type}${attrs.length > 0 ? ' ' + attrs.join(' ') : ''}>${inner}</${type}>`
}

// ---- 浏览器环境垫片 ------------------------------------------------------
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      captured = def
    },
  },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
}
const styleTags = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  head: { appendChild: (el) => styleTags.push(el) },
  body: {},
  addEventListener() {},
  removeEventListener() {},
}
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
globalThis.Node = class Node {}

// ---- 加载插件 ------------------------------------------------------------
const clientPath = 'E:\\随便玩玩dsh\\live-token-speed\\client.js'
await import(pathToFileURL(clientPath).href)

const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
}

assert(captured !== null, '模块加载器未被调用')
assert(captured.id === 'dsh-live-token-speed', 'id 不符：' + captured.id)

const mod = captured.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error('意外的 require: ' + name)
})
assert(typeof mod.apply === 'function', 'apply 未导出')

// ---- 假 ctx --------------------------------------------------------------
const dictionaries = {}
const registrations = []
const injections = []

const slots = {
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
  inject(key, callback) {
    injections.push(key)
    return callback()
  },
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(name) {
    return name === 'slots' ? slots : undefined
  },
  locale: {
    register(ns, dicts) {
      dictionaries[ns] = dicts
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const table = dictionaries[ns]
        const dict = table?.zh ?? table?.en ?? {}
        const raw = dict[key] ?? key
        if (!params) return raw
        return raw.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k])))
      }
    },
  },
}

mod.apply(ctx)

// ---- 断言注册 ------------------------------------------------------------
assert(dictionaries['live-token-speed'] !== undefined, '语言词典未注册')
assert(injections.includes('conversation.composer.dock'), '未 inject composer.dock')

const reg = registrations.find((r) => r.options.name === 'conversation.composer.dock')
assert(reg !== undefined, '未注册 composer.dock')
assert(reg.options.id === 'activity', 'id 应为 activity，实为 ' + reg.options.id)
assert(reg.options.priority === -1000, 'priority 应为 -1000，实为 ' + reg.options.priority)
assert(reg.options.locale === 'live-token-speed', 'locale 命名空间缺失')
assert(reg.options.order === 0, 'order 应为 0')
assert(styleTags.length === 1, '样式标签应注入 1 个，实为 ' + styleTags.length)

// ---- 渲染用例 ------------------------------------------------------------
const t = ctx.locale.bind('live-token-speed')
const Comp = reg.component

const makeSnapshot = ({ partial = null, nodes = [] } = {}) => ({ legacy: { partial, nodes } })
const baseProps = (snapshot, projection) => ({
  useChat: (selector) => selector(snapshot),
  useProjection: () => projection,
  t,
})

const assistantNode = {
  kind: 'assistant',
  turn: 1,
  time: 1000,
  timing: { stepStartTime: 0, firstTokenTime: 100, completedTime: 1100 },
  usage: { outputTokens: 100 },
}

const cases = [
  ['空闲·无数据', baseProps(makeSnapshot(), undefined)],
  ['空闲·有历史', baseProps(makeSnapshot({ nodes: [assistantNode] }), undefined)],
  [
    '流式中',
    baseProps(
      makeSnapshot({
        partial: {
          turn: 1,
          step: 2,
          blocks: [
            { kind: 'text', text: '这是一段正在流式输出的中文内容，用来验证实时速度计算不会崩。' },
            { kind: 'reasoning', text: 'thinking about the problem carefully' },
          ],
        },
      }),
      undefined
    ),
  ],
  ['空 blocks', baseProps(makeSnapshot({ partial: { turn: 1, step: 1, blocks: [] } }), undefined)],
  [
    '有 projection',
    baseProps(makeSnapshot({ nodes: [assistantNode] }), {
      turns: 3,
      steps: 5,
      llmMs: 12000,
      toolMs: 4000,
      ttftMs: 900,
      ttftSteps: 3,
      decodeMs: 6000,
      decodeTokens: 600,
    }),
  ],
  [
    'tool-result 节点',
    baseProps(
      makeSnapshot({
        nodes: [
          assistantNode,
          { kind: 'tool-result', callTime: 500, time: 1500 },
        ],
      }),
      undefined
    ),
  ],
]

const signatures = []
for (const [name, props] of cases) {
  HOOK_LOG.length = 0
  const tree = Comp(props)
  const html = renderNode(tree)
  const sig = HOOK_LOG.map((h) => h[0]).join('>')
  signatures.push({ name, sig, html })
  console.log(`[${name}] 渲染成功，HTML 长度 ${html.length}，Hook 序列 ${sig || '(无)'}`)
  if (html.length > 0) console.log(`    ${html.slice(0, 200)}`)
}

// ---- Hook 顺序一致性 -----------------------------------------------------
// 关键断言：所有用例的 Hook 序列必须完全相同。内置组件曾在
// 「有数据才渲染」的分支里提前 return，导致 Hook 数量随数据变化 —— 正是本检查要拦的。
const first = signatures[0].sig
const mismatch = signatures.filter((s) => s.sig !== first)
assert(mismatch.length === 0, 'Hook 序列不一致：' + mismatch.map((m) => `${m.name}=${m.sig}`).join(' | '))
console.log('\nHook 序列在所有用例下一致 ✓')

// ---- 有数据时应真的显示 tok/s -------------------------------------------
const withHistory = signatures.find((s) => s.name === '空闲·有历史')
assert(/tok\/s/.test(withHistory.html), '有历史时应显示 tok/s，实际：' + withHistory.html)
console.log('有历史时显示速度读数 ✓')

const idleEmpty = signatures.find((s) => s.name === '空闲·无数据')
assert(idleEmpty.html === '', '完全无数据时应渲染为空，实际：' + idleEmpty.html)
console.log('完全无数据时不占位 ✓')

// 流式中（本轮尚无已完成节点）必须仍然占位，不能整条消失
const streamingCase = signatures.find((s) => s.name === '流式中')
assert(streamingCase.html !== '', '流式中应保留统计条，实际渲染为空')
assert(/tok\/s/.test(streamingCase.html), '流式中应显示 tok/s 占位，实际：' + streamingCase.html)
console.log('流式中保留统计条并显示占位 ✓')

console.log('\nALL CHECKS PASSED')
