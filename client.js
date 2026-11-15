// dsh-live-token-speed — 浏览器半（client 半，全部功能在此）。
//
// 目的：把输入框底部统计条里的「输出速度」从**全会话平均**
// （decodeTokens / decodeMs）改成**实时滑动窗口速度**（最近 2 秒的增量）。
//
// 做法：复用 conversation.composer.dock 的 'activity' 单元格并给一个很低的
// priority（同 id 即替换内置 ActivityPill）。实时值来自 chat 快照的
// legacy.partial —— 流式过程中 assistant-step 节点尚未 settle，只有 partial
// 携带正在增长的 blocks；settle 后 partial 归 null，此时回退到「本步平均」，
// 而不是全会话平均。
window.__ModuleLoader__.load({
	id: 'dsh-live-token-speed',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const React = require('react')
		const ReactDOM = require('react-dom')
		const h = React.createElement
		const { useState, useEffect, useRef, useMemo, useCallback } = React

		// ---- 采样参数 -------------------------------------------------------
		/** 滑动窗口长度：取最近 2 秒的增量，既跟手又不抖。 */
		const WINDOW_MS = 2000
		/** 窗口跨度不足这么久就先不出数（避免首帧除出天文数字）。 */
		const MIN_SPAN_MS = 150
		/** 显示刷新节流（10Hz）：比 rAF 稳，肉眼足够顺滑。 */
		const EMIT_MS = 100
		/** 采样缓冲上限（2 秒 × 60fps 有余量）。 */
		const MAX_SAMPLES = 240
		/** 非 CJK 文本的 token 密度，与 dsh-token-meter 的启发式保持一致。 */
		const CHARS_PER_TOKEN = 4

		const CSS_ID = 'dsh-live-token-speed/pill.css'
		const CSS = [
			'.lts_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
			'.lts_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
			'.lts_pill svg{flex:none;width:14px;height:14px}',
			'button.lts_pill{cursor:pointer}',
			'button.lts_pill:hover,button.lts_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.lts_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
			'.lts_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
			'.lts_panel{position:fixed;min-width:230px;max-width:340px;padding:10px 12px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#1e1e1e));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.25));z-index:2147483000}',
			'.lts_title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline;gap:12px}',
			'.lts_titleValue{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-weight:400}',
			'.lts_details{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0;font-size:12px;line-height:1.4}',
			'.lts_details dt{color:var(--dsw-alias-label-tertiary)}',
			'.lts_details dd{margin:0;text-align:right;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
			'.lts_live{color:var(--dsw-alias-state-business-primary,inherit)}',
		].join('')

		// ---- 语言 -----------------------------------------------------------
		const NS = 'live-token-speed'
		const zh = {
			'tps': '{tps} tok/s',
			'counts': '{turns} 轮 {steps} 步',
			'title': '会话统计',
			'dialog.live': '实时速度',
			'dialog.step': '本步平均',
			'dialog.session': '会话平均',
			'dialog.llmTime': '模型用时',
			'dialog.toolTime': '工具调用用时',
			'dialog.ttft': '首 token 平均（TTFT）',
			'unit.seconds': '{seconds}秒',
			'unit.minutes': '{minutes}分{seconds}秒',
			'streaming': '流式输出中',
			'idle': '空闲',
		}
		const en = {
			'tps': '{tps} tok/s',
			'counts': '{turns} turns {steps} steps',
			'title': 'Session statistics',
			'dialog.live': 'Live speed',
			'dialog.step': 'This step',
			'dialog.session': 'Session average',
			'dialog.llmTime': 'LLM time',
			'dialog.toolTime': 'Tool time',
			'dialog.ttft': 'Avg time to first token (TTFT)',
			'unit.seconds': '{seconds}s',
			'unit.minutes': '{minutes}m{seconds}s',
			'streaming': 'streaming',
			'idle': 'idle',
		}

		// ---- 纯函数 ---------------------------------------------------------
		/** 是否 CJK（含全角标点、假名、韩文）：这些字大致 1 字 1 token。 */
		function isCJK(cp) {
			return (
				(cp >= 0x2e80 && cp <= 0x9fff) || // CJK 部首 / 假名 / 统一汉字
				(cp >= 0xac00 && cp <= 0xd7af) || // 韩文音节
				(cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
				(cp >= 0xfe30 && cp <= 0xfe4f) || // 兼容标点
				(cp >= 0xff00 && cp <= 0xffef) || // 全角字符
				(cp >= 0x20000 && cp <= 0x2fa1f) // 扩展汉字
			)
		}

		/**
		 * 按密度估算一段文本的 token 数：CJK 约 1 字 1 token，其余 4 字 1 token。
		 * @param text - 待估算文本。
		 * @returns 估算 token 数。
		 */
		function estimateTokens(text) {
			if (typeof text !== 'string' || text === '') return 0
			let cjk = 0
			let other = 0
			for (const ch of text) {
				const cp = ch.codePointAt(0)
				if (isCJK(cp)) cjk += 1
				else other += 1
			}
			return cjk + Math.ceil(other / CHARS_PER_TOKEN)
		}

		/**
		 * 增量累计 blocks 的 token 数：blocks 每帧都被重建但文本只增不减，
		 * 因此只对新增后缀计数，避免每帧 O(n) 全量扫描。
		 * @param cache - 上一次的计数缓存（Map）。
		 * @param blocks - 当前 partial 的 blocks。
		 * @returns 当前累计 token 数。
		 */
		function countBlocks(cache, blocks) {
			let total = 0
			const seen = new Set()
			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i]
				if (block === undefined) continue
				let text = ''
				if (block.kind === 'text' || block.kind === 'reasoning') text = block.text || ''
				else if (block.kind === 'tool-call') text = block.argsRaw || ''
				else continue
				if (text === '') continue
				const key = block.kind + ':' + i
				seen.add(key)
				const prev = cache.get(key)
				if (prev !== undefined && text.length >= prev.length && text.startsWith(prev.text)) {
					const tokens = prev.tokens + estimateTokens(text.slice(prev.length))
					cache.set(key, { text, tokens, length: text.length })
					total += tokens
				} else {
					const tokens = estimateTokens(text)
					cache.set(key, { text, tokens, length: text.length })
					total += tokens
				}
			}
			// 清理已消失的 block（新一步/重置），防止缓存无限增长
			for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key)
			return total
		}

		/** 速度显示：≥10 取整，<10 保留一位小数。 */
		function formatTps(tps) {
			if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return null
			return tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10)
		}

		/** 紧凑时长：一分钟内 45.2s，超过则 2m42s。 */
		function formatDuration(ms, t) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
			const s = ms / 1000
			if (s < 60) return t('unit.seconds', { seconds: Math.round(s * 10) / 10 })
			const whole = Math.round(s)
			return t('unit.minutes', { minutes: Math.floor(whole / 60), seconds: whole % 60 })
		}

		/** 单个已 settle 的 assistant 节点 → 该步的 TTFT / 解码耗时 / 输出 token。 */
		function stepReading(node) {
			const timing = node && node.timing
			if (timing === undefined || timing === null) return { ttftMs: null, decodeMs: null, outputTokens: null }
			const usage = node.usage
			const outputTokens =
				usage !== undefined && usage !== null && typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0
					? usage.outputTokens
					: null
			return {
				ttftMs:
					timing.stepStartTime !== null && timing.stepStartTime !== undefined && timing.firstTokenTime !== null && timing.firstTokenTime !== undefined
						? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
						: null,
				decodeMs:
					timing.firstTokenTime !== null && timing.firstTokenTime !== undefined && typeof timing.completedTime === 'number'
						? Math.max(0, timing.completedTime - timing.firstTokenTime)
						: null,
				outputTokens,
			}
		}

		// ---- 实时速度 hook --------------------------------------------------
		/**
		 * 从流式 partial 采样出实时速度。
		 * 每帧把（时刻，累计 token）压入环形缓冲，再用最近 WINDOW_MS 的跨度求速度；
		 * 没有新 token 时窗口自然右移，速度随之衰减到 0。
		 * @param partial - chat 快照的 legacy.partial（流式中非 null）。
		 * @returns 实时 tok/s，或 null（未开始/已停止）。
		 */
		function useLiveSpeed(partial) {
			const [speed, setSpeed] = useState(null)
			const tokenCache = useRef(new Map())
			const tokensRef = useRef(0)
			const streaming = partial !== null && partial !== undefined
			// 新一步开始（turn/step 变化）时计数必须归零，否则会算出负速度
			const stepKey = streaming ? partial.turn + ':' + partial.step : null
			const stepKeyRef = useRef(stepKey)

			if (stepKey !== stepKeyRef.current) {
				stepKeyRef.current = stepKey
				tokenCache.current.clear()
				tokensRef.current = 0
			}

			// 每次渲染把最新累计 token 写进 ref，供 rAF 循环读取
			if (streaming) tokensRef.current = countBlocks(tokenCache.current, partial.blocks)
			else tokensRef.current = 0

			useEffect(() => {
				if (!streaming) {
					setSpeed(null)
					return undefined
				}
				const samples = [{ t: performance.now(), tokens: tokensRef.current }]
				let raf = 0
				let lastEmit = 0
				let cancelled = false
				const tick = () => {
					if (cancelled) return
					const now = performance.now()
					const tokens = tokensRef.current
					const tail = samples[samples.length - 1]
					if (tail === undefined || tail.tokens !== tokens) {
						samples.push({ t: now, tokens })
						if (samples.length > MAX_SAMPLES) samples.shift()
					}
					// 只保留窗口内的采样；窗口外的最后一个点作为基线
					while (samples.length > 2 && now - samples[0].t > WINDOW_MS) samples.shift()
					const base = samples[0]
					const span = now - base.t
					if (span >= MIN_SPAN_MS) {
						const next = ((tokens - base.tokens) / span) * 1000
						if (now - lastEmit >= EMIT_MS) {
							lastEmit = now
							setSpeed(next > 0 ? next : 0)
						}
					}
					raf = requestAnimationFrame(tick)
				}
				raf = requestAnimationFrame(tick)
				return () => {
					cancelled = true
					if (raf !== 0) cancelAnimationFrame(raf)
				}
			}, [streaming, stepKey])

			return speed
		}

		// ---- 统计 hook ------------------------------------------------------
		/** 从已 settle 的 chat 节点折叠出轮/步数与各项耗时（projection 缺失时的兜底）。 */
		function deriveStats(nodes) {
			const turns = new Set()
			let steps = 0
			let llmMs = 0
			let toolMs = 0
			let ttftMs = 0
			let ttftSteps = 0
			let decodeMs = 0
			let decodeTokens = 0
			for (const node of nodes) {
				if (node.kind === 'tool-result') {
					if (node.callTime !== null && node.callTime !== undefined) toolMs += Math.max(0, node.time - node.callTime)
					continue
				}
				if (node.kind !== 'assistant') continue
				turns.add(node.turn)
				steps += 1
				const timing = node.timing
				if (timing !== undefined && timing.stepStartTime !== null && timing.stepStartTime !== undefined) {
					llmMs += Math.max(0, timing.completedTime - timing.stepStartTime)
				}
				const reading = stepReading(node)
				if (reading.ttftMs !== null) {
					ttftMs += reading.ttftMs
					ttftSteps += 1
				}
				if (reading.decodeMs !== null && reading.outputTokens !== null) {
					decodeMs += reading.decodeMs
					decodeTokens += reading.outputTokens
				}
			}
			return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
		}

		// ---- 浮层定位 -------------------------------------------------------
		/** 点击外部 / Escape 关闭的小浮层，按触发元素位置贴在下方统计条上方。 */
		function useStatDialog() {
			const [open, setOpen] = useState(false)
			const [pos, setPos] = useState(null)
			const rootRef = useRef(null)
			const panelRef = useRef(null)

			const measure = useCallback(() => {
				const root = rootRef.current
				if (root === null) return
				const rect = root.getBoundingClientRect()
				const viewport = typeof window === 'undefined' ? 1024 : window.innerWidth
				const width = 300
				const left = Math.max(12, Math.min(Math.round(rect.left), Math.round(viewport - width - 12)))
				const bottom = Math.round((typeof window === 'undefined' ? 0 : window.innerHeight) - rect.top + 8)
				setPos({ left, bottom })
			}, [])

			useEffect(() => {
				if (!open) {
					setPos(null)
					return undefined
				}
				measure()
				const onKey = (event) => {
					if (event.key === 'Escape') setOpen(false)
				}
				const onPointer = (event) => {
					const panel = panelRef.current
					const root = rootRef.current
					const target = event.target
					if (panel !== null && target instanceof Node && panel.contains(target)) return
					if (root !== null && target instanceof Node && root.contains(target)) return
					setOpen(false)
				}
				document.addEventListener('keydown', onKey, true)
				document.addEventListener('pointerdown', onPointer, true)
				window.addEventListener('resize', measure)
				return () => {
					document.removeEventListener('keydown', onKey, true)
					document.removeEventListener('pointerdown', onPointer, true)
					window.removeEventListener('resize', measure)
				}
			}, [open, measure])

			return { open, setOpen, rootRef, panelRef, pos }
		}

		/** 仪表盘图标（内联 SVG，避免依赖 ui-primitives）。 */
		function GaugeIcon() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
				h('path', {
					d: 'M8 2a6 6 0 0 0-6 6c0 1.2.35 2.3.96 3.24a.75.75 0 1 0 1.27-.8A4.5 4.5 0 1 1 12.5 8a.75.75 0 0 0 1.5 0A6 6 0 0 0 8 2Z',
					fill: 'currentColor',
				}),
				h('path', {
					d: 'M8 4.75a.75.75 0 0 1 .74.63l1.5 5.25a.75.75 0 0 1-1.45.4l-1.5-5.25a.75.75 0 0 1 .71-.99Z',
					fill: 'currentColor',
				})
			)
		}

		// ---- 组件 -----------------------------------------------------------
		/**
		 * 替换内置 ActivityPill：显示轮/步数 + 实时 tok/s。
		 * 流式中读实时滑动窗口速度；settle 后回退到「本步平均」；都没有则不显示速度。
		 */
		const LiveActivityPill = React.memo(function LiveActivityPill({ useChat, useProjection, t }) {
			const partial = useChat((snapshot) => snapshot.legacy.partial)
			const nodes = useChat((snapshot) => snapshot.legacy.nodes)
			const live = useLiveSpeed(partial)

			const projected = useProjection('sessionStats')
			const fallback = useMemo(() => deriveStats(nodes), [nodes])
			const stats = projected !== undefined && projected !== null ? projected : fallback

			// 最近一个已 settle 的 assistant 节点 → 本步平均速度
			const stepSpeed = useMemo(() => {
				for (let i = nodes.length - 1; i >= 0; i--) {
					const node = nodes[i]
					if (node.kind !== 'assistant') continue
					const reading = stepReading(node)
					if (reading.decodeMs !== null && reading.outputTokens !== null && reading.decodeMs > 0 && reading.outputTokens > 0) {
						return (reading.outputTokens / reading.decodeMs) * 1000
					}
					return null
				}
				return null
			}, [nodes])

			const sessionSpeed =
				typeof stats.decodeMs === 'number' && stats.decodeMs > 0 && typeof stats.decodeTokens === 'number'
					? (stats.decodeTokens / stats.decodeMs) * 1000
					: null

			const streaming = partial !== null && partial !== undefined
			const isLive = live !== null && live !== undefined

			// 速度读数优先级：实时 > 本步平均。实时读数为 0（流式暂停）时也照实显示 0。
			let speedText = null
			if (isLive) speedText = t('tps', { tps: formatTps(live) ?? '0' })
			else if (stepSpeed !== null && stepSpeed > 0) speedText = t('tps', { tps: formatTps(stepSpeed) })

			// 流式刚开始、滑动窗口还没攒够样本时，先占位，避免统计条整条消失
			const placeholder = streaming && speedText === null ? t('tps', { tps: '—' }) : null
			const display = speedText ?? placeholder

			// ⚠️ Hook 必须在任何提前 return 之前调用完毕，否则渲染与否会让 Hook 数量不一致
			const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()

			const steps = typeof stats.steps === 'number' ? stats.steps : 0
			// 空闲且没有任何数据时才完全不占位；流式中永远保留（即使还没有速度读数）
			if (display === null && steps === 0) return null

			const counts = t('counts', { turns: stats.turns ?? 0, steps })
			const label =
				steps === 0
					? display
					: display === null
						? counts
						: [counts, h('span', { key: 'sep', className: 'lts_sep', 'aria-hidden': true }, '·'), display]

			const canOpen = typeof stats.llmMs === 'number' && (stats.llmMs > 0 || (stats.toolMs ?? 0) > 0 || display !== null)

			const pillContent = [h(GaugeIcon, { key: 'icon' }), h('span', { key: 'label', className: 'lts_label' }, label)]

			const panel =
				open && pos !== null && canOpen
					? ReactDOM.createPortal(
							h(
								'div',
								{
									ref: panelRef,
									className: 'lts_panel',
									style: { left: pos.left + 'px', bottom: pos.bottom + 'px' },
									role: 'dialog',
									'aria-label': t('title'),
								},
								h(
									'div',
									{ className: 'lts_title' },
									h('span', null, t('title')),
									h('span', { className: 'lts_titleValue' }, isLive ? t('streaming') : t('idle'))
								),
								h(
									'dl',
									{ className: 'lts_details' },
									[
										h('dt', { key: 'dt-live' }, t('dialog.live')),
										h('dd', { key: 'dd-live', className: isLive ? 'lts_live' : undefined }, display ?? '—'),
										stepSpeed !== null ? h('dt', { key: 'dt-step' }, t('dialog.step')) : null,
										stepSpeed !== null ? h('dd', { key: 'dd-step' }, t('tps', { tps: formatTps(stepSpeed) })) : null,
										sessionSpeed !== null ? h('dt', { key: 'dt-session' }, t('dialog.session')) : null,
										sessionSpeed !== null ? h('dd', { key: 'dd-session' }, t('tps', { tps: formatTps(sessionSpeed) })) : null,
										stats.llmMs > 0 ? h('dt', { key: 'dt-llm' }, t('dialog.llmTime')) : null,
										stats.llmMs > 0 ? h('dd', { key: 'dd-llm' }, formatDuration(stats.llmMs, t)) : null,
										(stats.toolMs ?? 0) > 0 ? h('dt', { key: 'dt-tool' }, t('dialog.toolTime')) : null,
										(stats.toolMs ?? 0) > 0 ? h('dd', { key: 'dd-tool' }, formatDuration(stats.toolMs, t)) : null,
										(stats.ttftSteps ?? 0) > 0 ? h('dt', { key: 'dt-ttft' }, t('dialog.ttft')) : null,
										(stats.ttftSteps ?? 0) > 0 ? h('dd', { key: 'dd-ttft' }, formatDuration(stats.ttftMs / stats.ttftSteps, t)) : null,
									].filter(Boolean)
								)
							),
							document.body
						)
					: null

			return h(
				'span',
				{ ref: rootRef, className: 'lts_anchor', 'data-composer-stat': 'activity', 'data-live-speed': isLive ? 'true' : undefined },
				canOpen
					? h(
							'button',
							{
								type: 'button',
								className: 'lts_pill',
								'aria-expanded': open ? 'true' : undefined,
								'aria-label': steps === 0 ? String(display) : counts + (display === null ? '' : ' · ' + display),
								onClick: () => setOpen(!open),
							},
							pillContent
						)
					: h('span', { className: 'lts_pill' }, pillContent),
				panel
			)
		})

		// ---- 插件主体 -------------------------------------------------------
		const inject = ['slots', 'locale']

		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.locale.register(NS, {
						zh,
						en,
					}),
				'live-token-speed: dictionaries'
			)

			const slots = ctx.get('slots')
			if (slots === undefined) {
				console.warn('[live-token-speed] slots 服务不可用，跳过注册')
				return
			}

			// 与内置 ActivityPill 同 id 'activity'（同单元格即替换），
			// priority 取很低值：entriesOfSlot 按 priority 升序取第一个存活项。
			slots.inject('conversation.composer.dock', () =>
				slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'activity',
						order: 0,
						priority: -1000,
						locale: NS,
					},
					LiveActivityPill
				)
			)

			// 样式注入一次（随页面存活，无需清理）
			if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
				const tag = document.createElement('style')
				tag.dataset.plugin = 'dsh-live-token-speed'
				tag.dataset.pluginCss = CSS_ID
				tag.textContent = CSS
				document.head.appendChild(tag)
			}
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
