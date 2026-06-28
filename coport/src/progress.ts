import { dim, fmtBytes, fmtRate, fmtPercent } from '@cofoundry/ui'

// Formatting helpers for the per-template progress rows rendered by runner.ts.

export type Phase = 'download' | 'verify' | 'install'

const PHASE_VERBS: Record<Phase, string> = {
    download: 'downloading',
    verify: 'verifying  ',
    install: 'installing ',
}

export const formatPhase = (phase: Phase, vmid: number): string =>
    `${PHASE_VERBS[phase]} ${dim(`→ VMID ${String(vmid).padEnd(4)}`)}`

export const QUEUED_DOWNLOAD = `${dim('queued')}     ${dim('→ download')}`
export const QUEUED_RESTORE = `${dim('queued')}     ${dim('→ restore ')}`

const BAR_WIDTH = 14

export const renderBar = (pct: number): string => {
    const clamped = Math.max(0, Math.min(100, pct))
    const filled = Math.round((clamped / 100) * BAR_WIDTH)
    return `${'█'.repeat(filled)}${dim('░'.repeat(BAR_WIDTH - filled))}`
}

export const formatDownload = (
    received: number,
    total: number,
    startedAt: number
): string => {
    const elapsed = Math.max(1, Date.now() - startedAt)
    const pct = total > 0 ? (received / total) * 100 : 0
    const size =
        total > 0
            ? `${fmtBytes(received)}/${fmtBytes(total)}`
            : fmtBytes(received)
    return `${renderBar(pct)} ${fmtPercent(pct)}  ${size.padEnd(22)} ${fmtRate(received, elapsed).padStart(10)}`
}

export const formatRestoreProgress = (pct: number): string =>
    `${renderBar(pct)} ${fmtPercent(pct)}`

// Throttle per-chunk progress callbacks (and the matching renderer redraw) so
// many large concurrent transfers don't stall the event loop with redraws.
export const PROGRESS_THROTTLE_MS = 120
