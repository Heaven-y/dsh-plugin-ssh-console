window.__ModuleLoader__.load({
  id: 'dsh-plugin-ssh-console',
  factory(require) {
    const React = require('react')
    const z = require('zod')
    const h = React.createElement

    const PKG = 'dsh-plugin-ssh-console'
    const LOCALE_NS = 'ssh-console'
    const SERVICE_KEY = 'sshConsole'
    /** Remembers the last picked target across reloads. */
    const STORAGE_KEY = 'dsh.ssh-console.serverId'

    /* ---------------------------------------------------------------- styles */

    const CSS = `
.ssc-page{position:relative;box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.ssc-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ssc-head-icon{flex:none;display:inline-flex;color:var(--dsw-alias-label-secondary)}
.ssc-title{margin:0;font-size:15px;line-height:22px;font-weight:600;letter-spacing:.01em}
.ssc-spacer{flex:1}
.ssc-pill{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.ssc-pill-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.ssc-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.ssc-body{flex:1;min-height:0;overflow:auto;padding:16px 20px 28px}
.ssc-notice{flex:none;display:flex;align-items:flex-start;gap:8px;margin:14px 20px 0;padding:10px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.ssc-notice-close{flex:none;margin-left:auto;padding:0 4px;border:0;background:transparent;color:inherit;font-size:14px;line-height:16px;cursor:pointer;opacity:.7}
.ssc-notice-close:hover{opacity:1}

/* connection card */
.ssc-connect{display:flex;flex-direction:column;gap:16px;max-width:560px;margin:0 auto;padding:20px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.ssc-connect-lead{display:flex;flex-direction:column;gap:4px}
.ssc-connect-title{margin:0;font-size:14px;line-height:20px;font-weight:600}
.ssc-connect-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ssc-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.ssc-field-label{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500}
.ssc-field-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.ssc-control{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none}
.ssc-control:focus{border-color:var(--dsw-alias-brand-primary)}
.ssc-control:disabled{opacity:.55}
select.ssc-control{appearance:none;padding-right:26px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 15px) 15px,calc(100% - 10px) 15px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.ssc-actions{display:flex;align-items:center;gap:8px}

/* buttons */
.ssc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.ssc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ssc-btn:disabled{opacity:.45;cursor:not-allowed}
.ssc-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:500}
.ssc-btn-primary:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-brand-primary)}
.ssc-btn-quiet{height:26px;padding:0 10px;font-size:12px}
.ssc-btn-icon{height:26px;width:26px;padding:0;font-size:15px;line-height:1}

/* connected server chips */
.ssc-strip{flex:none;display:flex;align-items:center;gap:8px;padding:10px 20px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow-x:auto}
.ssc-chips{display:flex;align-items:center;gap:6px;min-width:0}
.ssc-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;white-space:nowrap;cursor:pointer;max-width:240px}
.ssc-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ssc-chip-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:500}
.ssc-chip-name{max-width:150px;overflow:hidden;text-overflow:ellipsis}
.ssc-chip-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border:0;border-radius:3px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.65}
.ssc-chip-close:hover{opacity:1;background:var(--dsw-alias-border-l1)}
.ssc-scrim{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-base);background:color-mix(in srgb,var(--dsw-alias-bg-base) 74%,transparent);backdrop-filter:blur(2px)}
.ssc-modal{box-sizing:border-box;display:flex;flex-direction:column;width:min(520px,100%);max-height:100%;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 40px var(--dsw-alias-border-l2);box-shadow:0 12px 40px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);outline:none}
.ssc-modal-head{flex:none;display:flex;align-items:center;gap:12px;padding:14px 16px 0}
.ssc-modal-title{margin:0;font-size:14px;line-height:20px;font-weight:600}
.ssc-modal-close{flex:none;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;cursor:pointer}
.ssc-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ssc-modal-body{padding:4px 16px 16px}
.ssc-modal .ssc-connect{max-width:none;padding:0;border:0;border-radius:0;background:transparent}

/* tabs */
.ssc-tabs{flex:none;display:flex;gap:2px;padding:12px 20px 0}
.ssc-tab{height:28px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;cursor:pointer}
.ssc-tab:hover{color:var(--dsw-alias-label-primary)}
.ssc-tab-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:500}

/* overview */
.ssc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.ssc-card{display:flex;flex-direction:column;gap:6px;min-width:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ssc-card-label{color:var(--dsw-alias-label-secondary);font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.ssc-card-value{font-size:19px;line-height:25px;font-weight:600;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssc-card-sub{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssc-bar{position:relative;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}
.ssc-bar>i{position:absolute;inset:0 auto 0 0;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.ssc-bar>i.ssc-warn{background:var(--dsw-alias-state-warn-primary)}
.ssc-bar>i.ssc-hot{background:var(--dsw-alias-state-error-primary)}
.ssc-bar>i.ssc-tone-mem{background:var(--dsw-alias-label-secondary)}
.ssc-host{margin:0 0 14px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base)}
.ssc-host-head{display:flex;align-items:baseline;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.ssc-host-name{margin:0;font-size:13.5px;line-height:20px;font-weight:600}
.ssc-host-meta{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
.ssc-section{margin-top:14px}
.ssc-section-head{display:flex;align-items:baseline;gap:8px;margin:0 0 8px}
.ssc-section-title{margin:0;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;text-transform:uppercase}
.ssc-section-count{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.ssc-gpus{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.ssc-gpu{display:flex;flex-direction:column;gap:9px;min-width:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.ssc-gpu-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.ssc-gpu-idx{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ssc-gpu-name{flex:1;min-width:0;font-size:12px;overflow-wrap:anywhere}
.ssc-gpu-num{flex:none;font-size:15px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums}
.ssc-gpu-metric{display:flex;flex-direction:column;gap:4px;min-width:0}
.ssc-gpu-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.ssc-gpu-row-label{flex:none;min-width:24px;letter-spacing:.04em;text-transform:uppercase;font-size:9.5px}
.ssc-gpu-extra{margin-left:auto;font-size:10.5px}
.ssc-gpu-mem{min-width:0;font-size:10.5px;overflow-wrap:anywhere}
.ssc-gpu-metric>.ssc-gpu-row>.ssc-gpu-num{margin-left:auto}
.ssc-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.ssc-table th{padding:6px 8px;text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ssc-table td{padding:5px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The command column shows the whole line. Keeping the tail and dropping the
   head hides the interpreter and the script, which is what identifies a job. */
.ssc-table td.ssc-cmd{white-space:normal;overflow:visible;overflow-wrap:anywhere;word-break:break-word;min-width:22ch;max-width:70ch;line-height:16px}
.ssc-table th.ssc-cmd{min-width:22ch}
.ssc-table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}
/* Group heading inside the GPU process table: one per card. */
.ssc-table .ssc-group-row:hover td{background:transparent}
.ssc-table th.ssc-group{position:sticky;top:0;padding:6px 8px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l1);font-weight:600;font-size:11px;letter-spacing:0;text-transform:none;color:var(--dsw-alias-label-primary)}
.ssc-group-meta{margin-left:8px;font-weight:400;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.ssc-num{text-align:right;font-variant-numeric:tabular-nums}
.ssc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}

/* files */
/* The browser is mounted per host and hidden with display:none, so it must not
   contribute layout while another tab is on screen. */
.ssc-files{display:block}
.ssc-path{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.ssc-path-text{flex:1;min-width:0;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssc-entry{display:flex;align-items:center;gap:10px;width:100%;padding:6px 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.ssc-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ssc-entry-icon{flex:none;display:inline-flex;width:14px;height:14px;color:var(--dsw-alias-label-secondary)}
.ssc-entry-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssc-entry-size{flex:none;width:84px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
.ssc-entry-time{flex:none;width:128px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
.ssc-preview{margin-top:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ssc-preview-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ssc-preview-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.ssc-preview-body{margin:0;padding:10px 12px;max-height:320px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}

/* terminal */
.ssc-body-term{display:flex;flex-direction:column;overflow:hidden;padding:12px 20px 18px}
.ssc-term{display:flex;flex-direction:column;gap:8px;flex:1;height:100%;min-height:0}
.ssc-term-bar{flex:none;display:flex;align-items:center;gap:6px}
.ssc-term-title{font-size:12.5px;font-weight:600}
.ssc-term-who{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.ssc-btn-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
/* One strip entry per open terminal; the slot badge says which pane holds it. */
.ssc-term-strip{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ssc-tchip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 6px 0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer;white-space:nowrap}
.ssc-tchip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ssc-tchip-on{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ssc-tchip-focus{border-color:var(--dsw-alias-brand-primary)}
.ssc-tchip-slot{color:var(--dsw-alias-brand-primary);font-size:10.5px}
.ssc-tchip-close{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:0;border-radius:3px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.6}
.ssc-tchip-close:hover{opacity:1;background:var(--dsw-alias-border-l1)}
/* Panes: one or two terminals side by side or stacked. */
.ssc-term-panes{display:flex;gap:8px;flex:1;min-height:0;min-width:0}
.ssc-term-row{flex-direction:row}
.ssc-term-column{flex-direction:column}
.ssc-pane{display:flex;flex-direction:column;flex:1 1 0;min-width:0;min-height:0}
.ssc-pane-body{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0}
.ssc-pane-body>.ssc-term-shell{flex:1;min-height:0}
.ssc-pane-size{align-self:flex-end;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:14px}
.ssc-pane-exit{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ssc-pane-focused>.ssc-pane-body>.ssc-term-shell{border-color:var(--dsw-alias-brand-primary)}
.ssc-pane-hint{flex:none;align-self:center;width:26px;height:26px;padding:0;border:.5px dashed var(--dsw-alias-border-l2);border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer}
.ssc-pane-hint:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ssc-term-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;flex:1;min-height:0}
.ssc-term-shell{position:relative;flex:1;min-height:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ssc-term-host{position:absolute;inset:0;padding:8px}
.ssc-term-host .xterm{height:100%}
.ssc-term-host .xterm-viewport{background:transparent!important;scrollbar-width:thin}
.ssc-term-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px}
.ssc-table-wrap{overflow-x:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px}
/* The command column wraps, so the table itself needs no wide floor; this only
   keeps the numeric columns from being squeezed on a narrow panel. */
.ssc-table-wide{min-width:520px}
.ssc-table-wide th:first-child,.ssc-table-wide td:first-child{padding-left:12px}
.ssc-table-wide th:last-child,.ssc-table-wide td:last-child{padding-right:12px}

/* empty + hints */
.ssc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:220px;padding:24px;color:var(--dsw-alias-label-secondary);text-align:center}
.ssc-empty-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ssc-empty-body{margin:0;font-size:12px;line-height:18px;max-width:420px}
.ssc-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px}
.ssc-fail{color:var(--dsw-alias-state-error-primary)}
`

    /**
     * Insert this bundle's stylesheet once and hand back its removal.
     * @returns the cleanup callback.
     */
    function insertStyles() {
      if (typeof document === 'undefined') return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /* ----------------------------------------------------------------- icons */

    /** Terminal glyph on the 16×16 grid the host's icon set uses. */
    function ConsoleIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        strokeWidth: 1.2, 'aria-hidden': true, focusable: 'false',
      },
      h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.6, stroke: 'currentColor' }),
      h('path', { d: 'M4.2 6.3L6.1 8L4.2 9.7', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M8.2 10H11.4', stroke: 'currentColor', strokeLinecap: 'round' }))
    }

    /** Folder glyph. */
    function FolderIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1.1, 'aria-hidden': true },
        h('path', {
          d: 'M1.8 4.1C1.8 3.6 2.2 3.2 2.7 3.2H6L7.4 4.8H13.3C13.8 4.8 14.2 5.2 14.2 5.7V11.9C14.2 12.4 13.8 12.8 13.3 12.8H2.7C2.2 12.8 1.8 12.4 1.8 11.9V4.1Z',
          stroke: 'currentColor',
        }))
    }

    /** Document glyph. */
    function FileIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1.1, 'aria-hidden': true },
        h('path', { d: 'M3.4 2.4H9.3L12.6 5.7V13.6H3.4V2.4Z', stroke: 'currentColor' }),
        h('path', { d: 'M9.2 2.5V5.8H12.5', stroke: 'currentColor' }))
    }

    /** Link glyph. */
    function LinkIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1.1, 'aria-hidden': true },
        h('path', { d: 'M6.6 9.4L9.4 6.6', stroke: 'currentColor', strokeLinecap: 'round' }),
        h('path', { d: 'M7.6 5.1L9 3.7C10.2 2.5 12.1 2.5 13.3 3.7C14.5 4.9 14.5 6.8 13.3 8L11.9 9.4', stroke: 'currentColor', strokeLinecap: 'round' }),
        h('path', { d: 'M8.4 10.9L7 12.3C5.8 13.5 3.9 13.5 2.7 12.3C1.5 11.1 1.5 9.2 2.7 8L4.1 6.6', stroke: 'currentColor', strokeLinecap: 'round' }))
    }

    /* --------------------------------------------------------------- helpers */

    const zh = {
      'panel.title': 'SSH 控制台',
      'empty.title': '没有可用的服务器',
      'empty.body': '在 ~/.ssh/config 里声明 Host，或在本插件 cordis.patch.yml 的 servers 里添加条目。',
      'connect.title': '连接到服务器',
      'connect.subtitle': '选择一台主机建立连接；可以同时连多台，连上后从标签条切换。',
      'connect.server': '服务器',
      'connect.serverNone': '未选择',
      'connect.password': '密码 / 密钥口令',
      'connect.passwordPlaceholder': '可留空',
      'connect.passwordHint': '留空则使用 ~/.ssh 下的私钥或 ssh-agent。密码只保留在内存中，不会写入磁盘。',
      'connect.action': '连接',
      'connect.connecting': '连接中…',
      'connect.disconnect': '断开',
      'connect.add': '连接其他服务器',
      'state.connected': '{count} 台已连接',
      'state.idle': '未连接',
      'tab.overview': '概览',
      'tab.processes': '进程',
      'tab.files': '文件',
      'tab.terminal': '终端',
      'cpu': 'CPU',
      'cpu.cores': '{count} 核',
      'memory': '内存',
      'load': '负载',
      'disk': '磁盘',
      'uptime': '已运行',
      'gpu': 'GPU',
      'gpu.none': '未检测到 NVIDIA GPU',
      'gpu.util': '利用率',
      'gpu.memory': '显存',
      'gpu.procs': '{count} 进程',
      'gpu.processes': 'GPU 进程',
      'processes': '进程（按 CPU 排序）',
      'processes.empty': '这台主机没有返回进程列表',
      'col.pid': 'PID',
      'col.ppid': 'PPID',
      'col.user': '用户',
      'col.cpu': 'CPU',
      'col.mem': '内存%',
      'col.rss': '常驻内存',
      'col.threads': '线程',
      'col.elapsed': '运行时长',
      'col.state': '状态',
      'col.command': '命令',
      'col.gpu': 'GPU',
      'files.up': '上一级',
      'files.refresh': '刷新',
      'files.loading': '加载中…',
      'files.empty': '这个目录是空的',
      'files.truncated': '条目过多，只显示前 {count} 项',
      'files.binary': '二进制文件，无法预览',
      'files.clipped': '内容较长，仅显示开头',
      'files.close': '关闭',
      'terminal.title': '交互式终端',
      'terminal.opening': '正在打开…',
      'terminal.close': '关闭终端',
      'terminal.reconnect': '重新打开',
      'terminal.exited': '终端已退出（退出码 {code}）',
      'terminal.cols': '{cols}×{rows}',
      'terminal.new': '新建',
      'terminal.splitRow': '左右分屏',
      'terminal.splitColumn': '上下分屏',
      'terminal.unsplit': '取消分屏',
      'terminal.none': '这台服务器上没有打开的终端',
      'error.dismiss': '关闭',
      'poll.failed': '采样失败',
      'since': '已连接 {duration}',
    }

    const en = {
      'panel.title': 'SSH Console',
      'empty.title': 'No server available',
      'empty.body': 'Declare a Host in ~/.ssh/config, or add entries under servers in this plugin’s cordis.patch.yml.',
      'connect.title': 'Connect to a server',
      'connect.subtitle': 'Pick a host to open a connection; several can stay open and you switch between them by chip.',
      'connect.server': 'Server',
      'connect.serverNone': 'None selected',
      'connect.password': 'Password / key passphrase',
      'connect.passwordPlaceholder': 'Optional',
      'connect.passwordHint': 'Leave empty to use a key under ~/.ssh or ssh-agent. Passwords stay in memory and are never written to disk.',
      'connect.action': 'Connect',
      'connect.connecting': 'Connecting…',
      'connect.disconnect': 'Disconnect',
      'connect.add': 'Connect another server',
      'state.connected': '{count} connected',
      'state.idle': 'Not connected',
      'tab.overview': 'Overview',
      'tab.processes': 'Processes',
      'tab.files': 'Files',
      'tab.terminal': 'Terminal',
      'cpu': 'CPU',
      'cpu.cores': '{count} cores',
      'memory': 'Memory',
      'load': 'Load',
      'disk': 'Disk',
      'uptime': 'Uptime',
      'gpu': 'GPU',
      'gpu.none': 'No NVIDIA GPU detected',
      'gpu.util': 'Util',
      'gpu.memory': 'VRAM',
      'gpu.procs': '{count} processes',
      'gpu.processes': 'GPU processes',
      'processes': 'Processes (by CPU)',
      'processes.empty': 'This host returned no process list',
      'col.pid': 'PID',
      'col.ppid': 'PPID',
      'col.user': 'User',
      'col.cpu': 'CPU',
      'col.mem': 'MEM%',
      'col.rss': 'RSS',
      'col.threads': 'Threads',
      'col.elapsed': 'Elapsed',
      'col.state': 'State',
      'col.command': 'Command',
      'col.gpu': 'GPU',
      'files.up': 'Up',
      'files.refresh': 'Refresh',
      'files.loading': 'Loading…',
      'files.empty': 'This directory is empty',
      'files.truncated': 'Too many entries; showing the first {count}',
      'files.binary': 'Binary file, no preview',
      'files.clipped': 'Long file; showing the beginning',
      'files.close': 'Close',
      'terminal.title': 'Interactive terminal',
      'terminal.opening': 'Opening…',
      'terminal.close': 'Close terminal',
      'terminal.reconnect': 'Open again',
      'terminal.exited': 'The terminal exited (code {code})',
      'terminal.cols': '{cols}×{rows}',
      'terminal.new': 'New',
      'terminal.splitRow': 'Split right',
      'terminal.splitColumn': 'Split down',
      'terminal.unsplit': 'No split',
      'terminal.none': 'No terminal is open on this server',
      'error.dismiss': 'Close',
      'poll.failed': 'sampling failed',
      'since': 'connected for {duration}',
    }

    /**
     * Read the locale id out of whatever shape the locale service exposes.
     * @param snapshot - `getLocale()` result.
     * @returns an id such as `zh-CN`.
     */
    function localeIdOf(snapshot) {
      if (typeof snapshot === 'string') return snapshot
      if (snapshot !== null && typeof snapshot === 'object') {
        const candidate = snapshot.id ?? snapshot.locale ?? snapshot.current
        if (typeof candidate === 'string') return candidate
      }
      return 'en'
    }

    /**
     * Build a translate function from the bundle's own dictionaries.
     * @param localeClient - the Client locale service.
     * @returns `t(key, vars)`.
     */
    function makeFallbackTranslate(localeClient) {
      return (key, vars) => {
        let id = 'en'
        try {
          id = localeIdOf(localeClient?.getLocale?.())
        } catch {
          id = 'en'
        }
        const dictionary = id.toLowerCase().startsWith('zh') ? zh : en
        const raw = dictionary[key] ?? en[key] ?? key
        if (vars === undefined) return raw
        return raw.replace(/\{(\w+)\}/g, (whole, name) => (
          Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
        ))
      }
    }

    /**
     * Format a byte count.
     * @param bytes - size in bytes.
     * @returns display text.
     */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
      return `${value.toFixed(digits)} ${units[unit]}`
    }

    /**
     * Format a duration compactly.
     * @param ms - milliseconds.
     * @returns display text.
     */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      const seconds = Math.floor(ms / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h ${minutes % 60}m`
      return `${Math.floor(hours / 24)}d ${hours % 24}h`
    }

    /**
     * Format a modification time.
     * @param ms - epoch milliseconds.
     * @returns display text.
     */
    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Pick the bar tone for a utilization percentage.
     * @param percent - 0–100.
     * @returns the modifier class.
     */
    function toneClass(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return ''
      if (percent >= 90) return 'ssc-hot'
      if (percent >= 70) return 'ssc-warn'
      return ''
    }

    /* ----------------------------------------------------------------- state */

    /**
     * The mounted namespace service. The gateway publishes it as the Client
     * service `remote.<namespace>`, so it is bound through `ctx.inject` rather
     * than read with `ctx.get`, which refuses undeclared keys.
     */
    let api

    /**
     * Read the Remote result envelope, raising its failure.
     * @param result - the value the namespace method resolved to.
     * @returns the payload.
     */
    function unwrap(result) {
      if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') {
        if (result.ok !== true) {
          const failure = result.error ?? {}
          const error = new Error(failure.message ?? 'Remote call failed')
          error.code = failure.code
          throw error
        }
        return result.value
      }
      return result
    }

    /**
     * Wait until the bound namespace is available. The mount creates it as a
     * Client service, and `ctx.inject` delivers it on a later tick, so the first
     * render can legitimately happen before the binding lands.
     * @returns the namespace service.
     */
    async function whenBound() {
      if (api !== undefined && api !== null) return api
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        if (api !== undefined && api !== null) return api
      }
      throw new Error('SSH service is unavailable: its Host endpoint is not mounted.')
    }

    /**
     * Call one Host method.
     *
     * The gateway rebuilds the Host argument object from the descriptor's
     * parameters and rejects any field the method signature does not declare, so
     * every call passes exactly one `input` object — matching the one parameter
     * each Host method takes.
     * @param method - Remote method name.
     * @param input - its single object parameter.
     * @returns the payload.
     */
    async function call(method, input) {
      const service = await whenBound()
      const serviceMethod = service[method]
      if (typeof serviceMethod !== 'function') {
        throw new Error(`SSH service has no method "${method}".`)
      }
      return unwrap(await serviceMethod(input ?? {}))
    }

    /* ------------------------------------------------------------ components */

    /** The sidebar icon: the panel row owns the button, this draws the glyph. */
    function ConsolePanelIcon(props) {
      return h(ConsoleIcon, { size: props?.size ?? 16 })
    }

    /**
     * One labelled statistic with an optional bar.
     * @param props - label, value, sub text, percentage.
     * @returns the card.
     */
    function StatCard({ label, value, sub, percent }) {
      return h('div', { className: 'ssc-card' },
        h('span', { className: 'ssc-card-label' }, label),
        h('span', { className: 'ssc-card-value' }, value),
        typeof percent === 'number' && Number.isFinite(percent)
          ? h('div', { className: 'ssc-bar' },
            h('i', { className: toneClass(percent), style: { width: `${Math.max(0, Math.min(100, percent))}%` } }))
          : null,
        sub === undefined ? null : h('span', { className: 'ssc-card-sub' }, sub))
    }

    /**
     * One GPU device card in the style of nvitop's device row.
     *
     * Utilization and memory each get their own bar directly under their own
     * numbers. A single bar between the two rows reads as the memory gauge
     * no matter which figure it actually tracks.
     * @param props - the device snapshot and the locale lookup.
     * @returns the card.
     */
    function GpuCard({ device, t }) {
      const memoryPercent = device.memoryTotalMiB > 0
        ? (device.memoryUsedMiB / device.memoryTotalMiB) * 100
        : undefined
      const clamp = (value) => Math.max(0, Math.min(100, value ?? 0))
      return h('div', { className: 'ssc-gpu' },
        h('div', { className: 'ssc-gpu-head' },
          h('span', { className: 'ssc-gpu-idx' }, `#${device.index}`),
          h('span', { className: 'ssc-gpu-name', title: device.name }, device.name)),
        h('div', { className: 'ssc-gpu-metric' },
          h('div', { className: 'ssc-gpu-row' },
            h('span', { className: 'ssc-gpu-row-label' }, t('gpu.util')),
            h('span', { className: 'ssc-gpu-num' }, `${device.utilization ?? '—'}%`),
            h('span', { className: 'ssc-gpu-extra' }, [
              typeof device.temperatureC === 'number' ? `${device.temperatureC}°C` : null,
              typeof device.powerW === 'number' ? `${device.powerW.toFixed(0)} W` : null,
            ].filter(Boolean).join(' · '))),
          h('div', { className: 'ssc-bar' },
            h('i', { className: toneClass(device.utilization), style: { width: `${clamp(device.utilization)}%` } }))),
        h('div', { className: 'ssc-gpu-metric' },
          h('div', { className: 'ssc-gpu-row' },
            h('span', { className: 'ssc-gpu-row-label' }, t('gpu.memory')),
            h('span', { className: 'ssc-gpu-mem' },
              `${formatBytes((device.memoryUsedMiB ?? 0) * 2 ** 20)} / ${formatBytes((device.memoryTotalMiB ?? 0) * 2 ** 20)}`),
            h('span', { className: 'ssc-gpu-num' }, typeof memoryPercent === 'number' ? `${memoryPercent.toFixed(0)}%` : '—')),
          h('div', { className: 'ssc-bar' },
            h('i', { className: 'ssc-tone-mem', style: { width: `${clamp(memoryPercent)}%` } }))))
    }

    /**
     * One connected host's block: the four headline statistics and its GPUs.
     * @param props - the session, its snapshot and the locale lookup.
     * @returns the block.
     */
    function HostBlock({ session, snapshot, t }) {
      const server = session.server ?? {}
      const failed = typeof snapshot?.error === 'string'
      const memory = snapshot?.memory ?? { totalBytes: 0, usedBytes: 0 }
      const memoryPercent = memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : undefined
      const gpus = snapshot?.gpu?.devices ?? []
      const gpuMemory = gpus.reduce((sum, device) => sum + (device.memoryUsedMiB ?? 0), 0)
      return h('section', { className: 'ssc-host' },
        h('div', { className: 'ssc-host-head' },
          h('h3', { className: 'ssc-host-name' }, session.hostname ?? server.host ?? ''),
          h('span', { className: 'ssc-host-meta' },
            [
              snapshot?.os ?? session.os,
              `${server.user === undefined || server.user === '' ? '' : `${server.user}@`}${server.host}:${server.port}`,
              typeof session.since === 'number' ? t('since', { duration: formatDuration(Date.now() - session.since) }) : null,
            ].filter(Boolean).join(' · '))),
        snapshot === null || snapshot === undefined
          ? h('div', { className: 'ssc-hint' }, t('files.loading'))
          : failed
            ? h('div', { className: 'ssc-hint ssc-fail' }, `${t('poll.failed')}: ${snapshot.error}`)
            : h(React.Fragment, null,
            h('div', { className: 'ssc-cards' },
              h(StatCard, {
                label: t('cpu'),
                value: typeof snapshot.cpu?.percent === 'number' ? `${snapshot.cpu.percent.toFixed(1)}%` : '—',
                sub: typeof snapshot.cpu?.cores === 'number' ? t('cpu.cores', { count: snapshot.cpu.cores }) : undefined,
                percent: snapshot.cpu?.percent,
              }),
              h(StatCard, {
                label: t('memory'),
                value: `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
                sub: typeof memoryPercent === 'number' ? `${memoryPercent.toFixed(0)}%` : undefined,
                percent: memoryPercent,
              }),
              h(StatCard, {
                label: t('load'),
                value: (snapshot.cpu?.load ?? []).map((value) => value.toFixed(2)).join('  '),
                sub: snapshot.uptimeSeconds === undefined
                  ? undefined
                  : `${t('uptime')} ${formatDuration(snapshot.uptimeSeconds * 1000)}`,
              }),
              h(StatCard, {
                label: t('disk'),
                value: snapshot.disk === undefined ? '—' : `${snapshot.disk.usedPercent}%`,
                sub: snapshot.disk === undefined
                  ? undefined
                  : `${snapshot.disk.filesystem} · ${snapshot.disk.used} / ${snapshot.disk.size}`,
                percent: snapshot.disk === undefined ? undefined : snapshot.disk.usedPercent,
              })),
            h('div', { className: 'ssc-section' },
              h('div', { className: 'ssc-section-head' },
                h('h4', { className: 'ssc-section-title' }, t('gpu')),
                gpus.length > 0
                  ? h('span', { className: 'ssc-section-count' },
                    `${gpus.length} · ${t('gpu.memory')} ${formatBytes(gpuMemory * 2 ** 20)}`)
                  : null),
              snapshot.gpu?.supported === false || gpus.length === 0
                ? h('div', { className: 'ssc-hint' }, t('gpu.none'))
                : h('div', { className: 'ssc-gpus' },
                  gpus.map((device) => h(GpuCard, { key: device.index, device, t }))))))
    }

    /**
     * The overview tab: the selected host only.
     *
     * Switching host is the chip strip's job, so this renders exactly one host —
     * stacking every connected machine made a second host push the first one's
     * numbers off screen.
     * @param props - the selected session, its snapshot and the locale lookup.
     * @returns the tab body.
     */
    function OverviewTab({ session, snapshot, t }) {
      return h(HostBlock, { session, snapshot, t })
    }

    /**
     * The GPU processes of one host: which card, whose process, and its command.
     *
     * The command is shown in full and allowed to wrap. Shortening it dropped the
     * interpreter and the script — exactly the part that says what the job is.
     *
     * Rows are grouped by card with a heading per group: a busy host runs dozens
     * of compute processes, and a flat list makes "what is on #3" a scan instead
     * of a glance.
     * @param props - the rows and the locale lookup.
     * @returns the table, or null when the host reports none.
     */
    function GpuProcessTable({ rows, t }) {
      if (rows.length === 0) return null

      const groups = new Map()
      for (const process of rows) {
        const key = process.gpuIndex === undefined ? -1 : process.gpuIndex
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(process)
      }
      const keys = [...groups.keys()].sort((left, right) => left - right)

      const bodies = keys.map((key) => {
        const mine = groups.get(key)
        const total = mine.reduce((sum, process) => sum + (process.usedMiB ?? 0), 0)
        return h('tbody', { key: `gpu-${key}` },
          h('tr', { className: 'ssc-group-row' },
            h('th', { className: 'ssc-group', colSpan: 5, scope: 'rowgroup' },
              h('span', { className: 'ssc-mono' }, key < 0 ? '—' : `#${key}`),
              h('span', { className: 'ssc-group-meta' },
                `${t('gpu.procs', { count: mine.length })} · ${formatBytes(total * 2 ** 20)}`))),
          mine.map((process) => h('tr', { key: `${key}-${process.pid}` },
            h('td', { className: 'ssc-num ssc-mono' }, key < 0 ? '—' : `#${key}`),
            h('td', { className: 'ssc-num ssc-mono' }, process.pid),
            h('td', null, process.user ?? '—'),
            h('td', { className: 'ssc-num' }, formatBytes((process.usedMiB ?? 0) * 2 ** 20)),
            h('td', { className: 'ssc-mono ssc-cmd', title: process.command }, process.command ?? '—'))))
      })

      return h('div', { className: 'ssc-section' },
        h('div', { className: 'ssc-section-head' },
          h('h4', { className: 'ssc-section-title' }, t('gpu.processes')),
          h('span', { className: 'ssc-section-count' },
            `${t('gpu.procs', { count: rows.length })} · ${keys.length} GPU`)),
        h('div', { className: 'ssc-table-wrap' },
          h('table', { className: 'ssc-table ssc-table-wide' },
            h('thead', null, h('tr', null,
              h('th', { className: 'ssc-num' }, t('col.gpu')),
              h('th', { className: 'ssc-num' }, t('col.pid')),
              h('th', null, t('col.user')),
              h('th', { className: 'ssc-num' }, t('gpu.memory')),
              h('th', { className: 'ssc-cmd' }, t('col.command')))),
            bodies)))
    }

    /**
     * The top processes of one host, with the columns that make a busy GPU host
     * readable: resident memory, thread count and how long it has been running.
     * @param props - the rows and the locale lookup.
     * @returns the table.
     */
    function ProcessTable({ rows, t }) {
      const body = rows.map((process) => h('tr', { key: process.pid },
        h('td', { className: 'ssc-num ssc-mono' }, process.pid),
        h('td', null, process.user),
        h('td', { className: 'ssc-num' }, `${process.cpuPercent.toFixed(1)}%`),
        h('td', { className: 'ssc-num' }, `${process.memoryPercent.toFixed(1)}%`),
        h('td', { className: 'ssc-num' }, formatBytes(process.rssBytes)),
        h('td', { className: 'ssc-num' }, String(process.threads)),
        h('td', { className: 'ssc-num ssc-mono' }, process.elapsed),
        h('td', { className: 'ssc-mono', title: process.state }, process.state),
        h('td', { className: 'ssc-mono ssc-cmd', title: process.command }, process.command)))
      return h('div', { className: 'ssc-section' },
        h('div', { className: 'ssc-section-head' },
          h('h4', { className: 'ssc-section-title' }, t('processes')),
          h('span', { className: 'ssc-section-count' }, String(rows.length))),
        h('div', { className: 'ssc-table-wrap' },
          h('table', { className: 'ssc-table ssc-table-wide' },
            h('thead', null, h('tr', null,
              h('th', { className: 'ssc-num' }, t('col.pid')),
              h('th', null, t('col.user')),
              h('th', { className: 'ssc-num' }, t('col.cpu')),
              h('th', { className: 'ssc-num' }, t('col.mem')),
              h('th', { className: 'ssc-num' }, t('col.rss')),
              h('th', { className: 'ssc-num' }, t('col.threads')),
              h('th', { className: 'ssc-num' }, t('col.elapsed')),
              h('th', null, t('col.state')),
              h('th', { className: 'ssc-cmd' }, t('col.command')))),
            h('tbody', null, body))))
    }

    /**
     * The processes tab: the selected host only.
     *
     * Same rule as the overview — one host at a time, chosen by the chip strip,
     * so the tables never scroll past a second machine's heading.
     * @param props - the selected session, its snapshot and the locale lookup.
     * @returns the tab body.
     */
    function ProcessesTab({ session, snapshot, t }) {
      if (snapshot === null || snapshot === undefined) {
        return h('div', { className: 'ssc-hint' }, t('files.loading'))
      }
      if (typeof snapshot.error === 'string') {
        return h('div', { className: 'ssc-hint ssc-fail' }, `${t('poll.failed')}: ${snapshot.error}`)
      }
      const gpuRows = snapshot.gpuProcesses ?? []
      const rows = snapshot.processes ?? []
      return h(React.Fragment, null,
        h(GpuProcessTable, { rows: gpuRows, t }),
        rows.length === 0
          ? h('div', { className: 'ssc-hint' }, t('processes.empty'))
          : h(ProcessTable, { rows, t }))
    }

    /**
     * The files tab: a read-only directory walk with a text preview.
     *
     * One of these is mounted per connected server and only the selected one is
     * laid out, the same way terminals are kept. Unmounting it instead would put
     * the walk back at `~` on every tab switch, which loses the directory the
     * user was reading — the one piece of state in this panel that is expensive
     * to rebuild, because rebuilding it means SSH round trips.
     * @param props - the server id, whether it is laid out, and the locale lookup.
     * @returns the tab body.
     */
    function FilesTab({ serverId, t, visible }) {
      const [path, setPath] = React.useState('~')
      const [listing, setListing] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [preview, setPreview] = React.useState(null)
      const [previewLoading, setPreviewLoading] = React.useState(false)

      const load = React.useCallback(async (next) => {
        setLoading(true)
        setFailure('')
        try {
          const value = await call('listDir', { serverId, path: next })
          setListing(value)
          setPath(value.path)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
          setListing(null)
        } finally {
          setLoading(false)
        }
      }, [serverId])

      // First mount loads the home directory. `load` is keyed on the server, so
      // this runs once per server rather than on every render.
      const loadedRef = React.useRef(false)
      React.useEffect(() => {
        if (loadedRef.current) return
        loadedRef.current = true
        void load('~')
      }, [load])

      // Coming back to this tab re-reads the directory that is already open, so
      // what is shown is current without losing the user's place.
      React.useEffect(() => {
        if (!visible || !loadedRef.current) return
        void load(path)
        // `path` is deliberately read, not depended on: navigating while visible
        // loads its own directory, and re-running on every path change would
        // double every request.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [visible])

      const join = React.useCallback((base, name) => (base.endsWith('/') ? `${base}${name}` : `${base}/${name}`), [])

      const openEntry = React.useCallback((entry) => {
        if (entry.kind === 'directory') {
          void load(join(path, entry.name))
          setPreview(null)
          return
        }
        if (entry.kind === 'other') return
        setPreviewLoading(true)
        call('readText', { serverId, path: join(path, entry.name) })
          .then((value) => {
            setPreview(value)
          })
          .catch((error) => {
            setPreview({
              path: entry.name,
              text: '',
              binary: false,
              error: error instanceof Error ? error.message : String(error),
            })
          })
          .finally(() => {
            setPreviewLoading(false)
          })
      }, [join, path, serverId])

      const parentPath = React.useMemo(() => {
        const parts = path.replace(/\/+$/, '').split('/')
        if (parts.length <= 1) return '/'
        parts.pop()
        return parts.join('/') || '/'
      }, [path])

      return h('div', {
        className: 'ssc-files',
        style: visible ? undefined : { display: 'none' },
      },
      h('div', { className: 'ssc-path' },
          h('button', { type: 'button', className: 'ssc-btn ssc-btn-quiet', onClick: () => void load(parentPath), disabled: loading }, t('files.up')),
          h('span', { className: 'ssc-path-text', title: path }, path),
          h('button', { type: 'button', className: 'ssc-btn ssc-btn-quiet', onClick: () => void load(path), disabled: loading }, t('files.refresh'))),
        failure.length > 0 ? h('div', { className: 'ssc-hint ssc-fail', role: 'alert' }, failure) : null,
        loading && listing === null ? h('div', { className: 'ssc-empty' }, h('span', null, t('files.loading'))) : null,
        listing !== null && listing.entries.length === 0
          ? h('div', { className: 'ssc-empty' }, h('span', null, t('files.empty')))
          : null,
        listing !== null && listing.entries.length > 0
          ? h('div', null,
            listing.entries.map((entry) => h('button', {
              key: entry.name,
              type: 'button',
              className: 'ssc-entry',
              onClick: () => openEntry(entry),
              title: entry.name,
            },
            h('span', { className: 'ssc-entry-icon' },
              entry.kind === 'directory' ? h(FolderIcon) : entry.kind === 'symlink' ? h(LinkIcon) : h(FileIcon)),
            h('span', { className: 'ssc-entry-name' }, entry.name),
            h('span', { className: 'ssc-entry-size' }, entry.kind === 'directory' ? '—' : formatBytes(entry.sizeBytes)),
            h('span', { className: 'ssc-entry-time' }, formatTime(entry.modifiedMs)))),
            listing.truncated ? h('div', { className: 'ssc-hint' }, t('files.truncated', { count: listing.entries.length })) : null)
          : null,
        previewLoading ? h('div', { className: 'ssc-hint', style: { marginTop: 12 } }, t('files.loading')) : null,
        preview !== null
          ? h('div', { className: 'ssc-preview' },
            h('div', { className: 'ssc-preview-head' },
              h(FileIcon),
              h('span', { className: 'ssc-preview-title', title: preview.path }, preview.path),
              preview.error === undefined && preview.binary === false
                ? h('span', { className: 'ssc-hint' }, formatBytes(preview.sizeBytes))
                : null,
              h('button', { type: 'button', className: 'ssc-btn ssc-btn-quiet', onClick: () => setPreview(null) }, t('files.close'))),
            h('pre', { className: 'ssc-preview-body' },
              preview.error !== undefined
                ? preview.error
                : preview.binary === true
                  ? t('files.binary')
                  : `${preview.text}${preview.truncated === true ? `\n\n… ${t('files.clipped')}` : ''}`))
          : null)
    }
    /**
     * Resolve the few theme colours xterm needs.
     *
     * The renderer draws to a canvas, so it cannot take `var(--dsw-*)` strings;
     * the tokens are read off the document instead, which keeps the terminal in
     * step with the active light or dark theme.
     * @returns the terminal theme object.
     */
    function terminalTheme() {
      const fallback = {
        background: '#10141a',
        foreground: '#d7dde5',
        cursor: '#7fd4ff',
        selectionBackground: '#2b4a63',
      }
      if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return fallback
      try {
        const style = getComputedStyle(document.body)
        const supports = typeof CSS === 'undefined' || typeof CSS.supports !== 'function'
          ? () => true
          : (value) => CSS.supports('color', value)
        const read = (token) => {
          const value = style.getPropertyValue(token).trim()
          // The renderer wants a colour it can paint; a token holding a gradient
          // or an unsupported function would leave the screen unthemed.
          return value.length > 0 && supports(value) ? value : undefined
        }
        return {
          background: read('--dsw-alias-bg-layer-1') ?? fallback.background,
          foreground: read('--dsw-alias-label-primary') ?? fallback.foreground,
          cursor: read('--dsw-alias-brand-primary') ?? fallback.cursor,
          selectionBackground: read('--dsw-alias-interactive-bg-hover') ?? fallback.selectionBackground,
        }
      } catch {
        return fallback
      }
    }

    /**
     * Insert the vendored renderer's own base stylesheet, once per document.
     *
     * `@xterm/xterm` ships `xterm.css` and relies on it being on the page. The
     * Harness loads a package's Client half as a plain script, so nothing
     * injects it, and the renderer then runs unstyled: the glyph grid loses its
     * absolute positioning and characters overlap, while `.xterm-helper-textarea`
     * — normally hidden at zero size far off-screen — shows up as a real box the
     * user can type into.
     * @param css - the stylesheet text carried by the chunk.
     */
    function insertXtermStyles(css) {
      if (typeof document === 'undefined') return
      if (typeof css !== 'string' || css.length === 0) return
      if (document.querySelector('style[data-dsh-xterm]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.dshXterm = 'true'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /**
     * Smallest geometry a terminal may be opened or resized to.
     *
     * The Host enforces the same floor, but a fit against an unmeasurable box
     * produces 1–2 columns here first, and a PTY briefly told it is two columns
     * wide makes the shell wrap its prompt, redraw it, and leave the remains on
     * screen once the real width arrives.
     */
    const MIN_TERM_COLS = 20
    const MIN_TERM_ROWS = 5
    /** Geometry used when the pane cannot be measured yet, matching the Host default. */
    const FALLBACK_TERM_SIZE = Object.freeze({ cols: 100, rows: 30 })

    /**
     * Fit the emulator to its box, but only when that box is real.
     *
     * `fit()` reports a plausible-looking 2×1 for a hidden or not-yet-laid-out
     * container, and acting on that number is what corrupts the first render.
     * @param term - the emulator, or null.
     * @param fit - its fit addon, or null.
     * @param holder - the box it lives in.
     * @returns whether a usable geometry was measured.
     */
    function safeFit(term, fit, holder) {
      if (term === null || fit === null || holder === null) return false
      // A collapsed box is not a small terminal, it is an unmeasured one.
      if (holder.clientWidth < 40 || holder.clientHeight < 40) return false
      fit.fit()
      if (term.cols < MIN_TERM_COLS || term.rows < MIN_TERM_ROWS) return false
      return true
    }

    /**
     * One remote PTY rendered by the vendored xterm.
     *
     * Output is pulled with a short poll against a byte cursor rather than pushed
     * over a stream, so the transport stays request/response; the interval is
     * short enough that the echo of a keystroke appears immediately.
     *
     * The component is mounted for every terminal its owner knows about and is
     * only laid out while its pane is on screen. That is what makes a session
     * survive switching: the emulator keeps its scrollback, and the Host keeps
     * the PTY. Only an explicit close tears either down.
     * @param props - the server id, this terminal's id, whether it is laid out,
     *   whether it has keyboard focus and the locale lookup.
     * @returns the pane body.
     */
    function TerminalPane({ serverId, termId, t, visible, focused }) {
      const holderRef = React.useRef(null)
      const termRef = React.useRef(null)
      const fitRef = React.useRef(null)
      const cursorRef = React.useRef(0)
      const pendingRef = React.useRef('')
      const flushRef = React.useRef(undefined)
      const [phase, setPhase] = React.useState('closed')
      const [failure, setFailure] = React.useState('')
      const [size, setSize] = React.useState(null)
      const [exitCode, setExitCode] = React.useState(undefined)
      /** One automatic attempt per pane: a failing host must not spin. */
      const attemptedRef = React.useRef(false)
      /**
       * Guards the window in which `open()` has started but not finished.
       *
       * The guard below it (`termRef.current`) is only set after an await, so two
       * overlapping calls would both pass it and mount a second emulator into the
       * same holder: the stale one stays in the DOM, keeps its own `onData`, and
       * forwards every keystroke a second time. That is the corruption seen on the
       * first open, so the check has to be synchronous.
       */
      const openingRef = React.useRef(false)
      /**
       * Set once the first batch of output has been drawn.
       *
       * A resize before that would make the remote shell redraw its prompt at a
       * geometry the emulator never showed, and the redraw bookkeeping of a
       * wrapped prompt (`CR`, erase-to-end-of-line, cursor-up) then lands on the
       * wrong rows and leaves its tail on screen. Nothing may resize until the
       * screen shown and the screen described agree.
       */
      const readyRef = React.useRef(false)

      /**
       * Send buffered keystrokes in one call.
       *
       * Typing produces one `onData` per key; coalescing them keeps a fast typist
       * from spending a round trip per character without adding visible latency.
       */
      const flush = React.useCallback(() => {
        flushRef.current = undefined
        const data = pendingRef.current
        pendingRef.current = ''
        if (data.length === 0) return
        const bytes = new TextEncoder().encode(data)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        void call('termWrite', { serverId, termId, data: btoa(binary) }).catch(() => {
          // A closed channel surfaces on the next read instead.
        })
      }, [serverId, termId])

      /** Write base64 bytes into the emulator, honouring a reset request. */
      const drain = React.useCallback(async () => {
        const term = termRef.current
        if (term === null) return
        const result = await call('termRead', { serverId, termId, fromSeq: cursorRef.current })
        if (result.reset === true) term.reset()
        cursorRef.current = result.seq
        if (typeof result.data === 'string' && result.data.length > 0) {
          const binary = atob(result.data)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          term.write(bytes)
        }
        if (result.exited === true) {
          setPhase('exited')
          setExitCode(result.exitCode)
        }
      }, [serverId, termId])

      /** Mount the emulator in the holder and attach to this terminal. */
      const open = React.useCallback(async () => {
        if (openingRef.current) return
        openingRef.current = true
        readyRef.current = false
        setFailure('')
        setPhase('opening')
        try {
          const vendored = await require.async('./client.xterm.js')
          // The renderer ships its own base stylesheet and nothing else loads it.
          // Without it `.xterm-screen`/`.xterm-rows` lose their absolute
          // positioning, so the glyph grid collapses into normal text flow and
          // characters overlap — and the helper textarea, normally hidden at zero
          // size far off-screen, becomes a visible box a user can type into.
          insertXtermStyles(vendored.css)
          const holder = holderRef.current
          if (holder === null) throw new Error('The terminal container is not mounted yet.')
          if (termRef.current !== null) {
            termRef.current.dispose()
            termRef.current = null
          }
          // A previous instance that lost a race would still own child nodes here;
          // clearing first guarantees one canvas per pane.
          while (holder.firstChild !== null) holder.removeChild(holder.firstChild)
          const fit = new vendored.FitAddon()
          const term = new vendored.Terminal({
            cursorBlink: true,
            fontSize: 12.5,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            scrollback: 5000,
            allowProposedApi: true,
            theme: terminalTheme(),
          })
          term.loadAddon(fit)
          term.open(holder)
          // Only fit once the pane has a real box; a collapsed one reports a
          // 2-column geometry that would make the shell wrap its prompt.
          const measured = safeFit(term, fit, holder)
          const opening = measured
            ? { cols: term.cols, rows: term.rows }
            : { ...FALLBACK_TERM_SIZE }
          // Registered before the round trip: xterm answers terminal queries
          // through this channel, and a program that is waiting for a reply (a
          // `resize` call in a login script, say) must not be left guessing.
          term.onData((data) => {
            pendingRef.current += data
            if (flushRef.current === undefined) flushRef.current = setTimeout(flush, 16)
          })
          const opened = await call('termOpen', {
            serverId,
            termId,
            cols: opening.cols,
            rows: opening.rows,
          })
          // An attached terminal keeps the size the Host already had; adopt it so
          // the emulator and the PTY agree on where lines wrap. Only do it when the
          // box was measurable — otherwise this defers to the layout effect.
          if (measured && (opened.cols !== term.cols || opened.rows !== term.rows)) {
            term.resize(opened.cols, opened.rows)
          }
          termRef.current = term
          fitRef.current = fit
          cursorRef.current = 0
          setSize({ cols: opened.cols, rows: opened.rows })
          term.focus()
          setPhase('open')
          await drain()
          // The screen now shows what the PTY described, so resizes may follow.
          readyRef.current = true
          const holderNow = holderRef.current
          if (holderNow !== null) safeFit(term, fit, holderNow)
        } catch (error) {
          setPhase('closed')
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          openingRef.current = false
        }
      }, [drain, flush, serverId, termId])

      /** Re-open an exited or failed terminal in the same slot. */
      const reopen = React.useCallback(async () => {
        attemptedRef.current = true
        try {
          await call('termOpen', { serverId, termId })
        } catch {
          // The open below reports the real failure.
        }
        await open()
      }, [open, serverId, termId])

      // Opening the pane opens the terminal: there is nothing to configure, so a
      // second click would only be in the way. A failed attempt stays failed
      // until the user asks again, otherwise the effect would retry in a loop.
      React.useEffect(() => {
        if (!visible || phase !== 'closed') return
        if (attemptedRef.current) return
        attemptedRef.current = true
        void open()
        // `open` is stable for this terminal; re-running on phase is the trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [visible, phase])

      // Poll for output while this terminal is live.
      React.useEffect(() => {
        if (phase !== 'open') return undefined
        let alive = true
        const timer = setInterval(() => {
          if (!alive) return
          void drain().catch(() => {
            alive = false
            setPhase('exited')
          })
        }, 120)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [drain, phase])

      // Keep the remote PTY sized to the pane. A hidden pane reports a zero-sized
      // box, and fitting to that would resize the PTY to its floor.
      React.useEffect(() => {
        if (phase !== 'open' || !visible) return undefined
        const holder = holderRef.current
        if (holder === null) return undefined
        const refit = () => {
          const fit = fitRef.current
          const term = termRef.current
          if (fit === null || term === null) return
          // A resize before the first screen is drawn would make the shell redraw
          // its prompt at a geometry the emulator never showed, leaving the tail
          // of the old wrapped prompt behind.
          if (!readyRef.current) return
          const before = `${term.cols}x${term.rows}`
          if (!safeFit(term, fit, holder)) return
          if (`${term.cols}x${term.rows}` === before) return
          setSize({ cols: term.cols, rows: term.rows })
          void call('termResize', { serverId, termId, cols: term.cols, rows: term.rows }).catch(() => {})
        }
        let timer
        const onResize = () => {
          clearTimeout(timer)
          timer = setTimeout(refit, 180)
        }
        const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onResize)
        observer?.observe(holder)
        // Becoming visible again (tab switch, split, unsplit) needs an immediate fit.
        refit()
        return () => {
          clearTimeout(timer)
          observer?.disconnect()
        }
      }, [phase, visible, serverId, termId])

      // Typing should go to the pane the user clicked.
      React.useEffect(() => {
        if (!visible || !focused) return
        termRef.current?.focus()
      }, [visible, focused])

      // Unmounting the panel disposes the renderer but leaves the remote PTY
      // running, so reopening the page re-attaches to the same login.
      React.useEffect(() => () => {
        clearTimeout(flushRef.current)
        flushRef.current = undefined
        termRef.current?.dispose()
        termRef.current = null
      }, [termId])

      return h('div', { className: 'ssc-pane-body' },
        failure.length > 0 ? h('div', { className: 'ssc-hint ssc-fail', role: 'alert' }, failure) : null,
        phase === 'exited'
          ? h('div', { className: 'ssc-pane-exit' },
            h('span', { className: 'ssc-hint' }, t('terminal.exited', { code: exitCode ?? '—' })),
            h('button', { type: 'button', className: 'ssc-btn ssc-btn-quiet', onClick: () => void reopen() }, t('terminal.reconnect')))
          : null,
        h('div', { className: 'ssc-term-shell' },
          h('div', { className: 'ssc-term-host', ref: holderRef }),
          phase === 'opening'
            ? h('div', { className: 'ssc-term-placeholder' }, h('span', { className: 'ssc-hint' }, t('terminal.opening')))
            : null),
        size === null ? null : h('span', { className: 'ssc-pane-size' }, t('terminal.cols', size)))
    }

    /**
     * The terminal tab: a set of remote PTYs laid out as one or two panes.
     *
     * Model: a server holds N terminals (bounded by the Host), and the tab shows
     * one or two of them. The ones not shown stay mounted and keep running, so
     * switching costs nothing and loses no scrollback.
     * @param props - the server id, the prompt identity, whether the tab is on
     *   screen and the locale lookup.
     * @returns the tab body.
     */
    function TerminalTab({ serverId, t, who, visible }) {
      /** Every terminal open on this server, in creation order. */
      const [termIds, setTermIds] = React.useState([])
      /** The one (or two) currently laid out. */
      const [panes, setPanes] = React.useState([])
      const [orientation, setOrientation] = React.useState('row')
      const [focused, setFocused] = React.useState(0)
      const [failure, setFailure] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [booted, setBooted] = React.useState(false)

      // First sight of this tab: adopt whatever the Host still holds, or open one.
      React.useEffect(() => {
        if (!visible || booted) return
        setBooted(true)
        void (async () => {
          try {
            const listed = await call('termList', { serverId })
            const existing = (listed.terminals ?? []).map((entry) => entry.termId)
            if (existing.length > 0) {
              setTermIds(existing)
              setPanes([existing[0]])
              return
            }
            const opened = await call('termOpen', { serverId })
            setTermIds([opened.termId])
            setPanes([opened.termId])
          } catch (error) {
            setBooted(false)
            setFailure(error instanceof Error ? error.message : String(error))
          }
        })()
      }, [visible, booted, serverId])

      /** Open a new terminal and show it on its own. */
      const create = React.useCallback(async () => {
        setBusy(true)
        setFailure('')
        try {
          const opened = await call('termOpen', { serverId })
          setTermIds((current) => (current.includes(opened.termId) ? current : [...current, opened.termId]))
          setPanes([opened.termId])
          setFocused(0)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [serverId])

      /**
       * Split into a second pane, creating a terminal only when none is spare.
       *
       * This mirrors what `tmux split-window` does, which is the behaviour a
       * terminal user expects from a split button.
       */
      const split = React.useCallback(async (direction) => {
        setFailure('')
        setOrientation(direction)
        if (panes.length > 1) return
        const spare = termIds.find((id) => id !== panes[0])
        if (spare !== undefined) {
          setPanes([panes[0] ?? spare, spare])
          setFocused(1)
          return
        }
        setBusy(true)
        try {
          const opened = await call('termOpen', { serverId })
          setTermIds((current) => (current.includes(opened.termId) ? current : [...current, opened.termId]))
          setPanes([panes[0] ?? opened.termId, opened.termId])
          setFocused(1)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [panes, serverId, termIds])

      const unsplit = React.useCallback(() => {
        setPanes((current) => {
          const keep = current[focused] ?? current[0]
          return keep === undefined ? [] : [keep]
        })
        setFocused(0)
      }, [focused])

      /** Close one terminal for good; its PTY goes away on the Host too. */
      const closeTerm = React.useCallback(async (termId) => {
        setBusy(true)
        try {
          await call('termClose', { serverId, termId })
          setTermIds((current) => current.filter((id) => id !== termId))
          // Dropping the id is enough: the render below adopts a survivor when
          // this leaves no pane, so the view never blanks in between.
          setPanes((shown) => shown.filter((id) => id !== termId))
          setFocused(0)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [serverId])

      /**
       * Bring a terminal on screen, replacing what the focused pane held.
       * @param termId - the terminal to show.
       */
      const show = React.useCallback((termId) => {
        setPanes((current) => {
          if (current.length <= 1) return [termId]
          if (current.includes(termId)) {
            setFocused(current.indexOf(termId))
            return current
          }
          const next = [...current]
          next[focused] = termId
          return next
        })
      }, [focused])

      // A closed terminal must not leave its slot empty. The pane list has to be
      // repaired here rather than filtered at render time: a pane whose id is
      // gone would otherwise be dropped from the layout while its sibling stayed
      // mounted and hidden, which looks exactly like "closing one closed both".
      // A pane whose terminal is gone must be repaired in state, otherwise the
      // survivor stays mounted but hidden and the view looks empty.
      React.useEffect(() => {
        if (termIds.length === 0) {
          if (panes.length > 0) setPanes([])
          return
        }
        if (panes.length === 0) {
          setPanes([termIds[0]])
          return
        }
        if (panes.every((id) => termIds.includes(id))) return
        const surviving = panes.filter((id) => termIds.includes(id))
        setPanes(surviving.length > 0 ? surviving : [termIds[0]])
      }, [termIds, panes])

      // Derived at render time as well, so a close never shows a blank frame
      // while the repair effect above catches up.
      const live = panes.filter((id) => termIds.includes(id))
      const shown = live.length > 0 || termIds.length === 0 ? live : [termIds[0]]
      // Panes in layout order first, then the mounted-but-hidden ones.
      const ordered = [...shown, ...termIds.filter((id) => !shown.includes(id))]
      const splitting = shown.length > 1
      const spare = termIds.some((id) => !shown.includes(id))

      return h('div', { className: 'ssc-term', style: visible ? undefined : { display: 'none' } },
        h('div', { className: 'ssc-term-bar' },
          h('span', { className: 'ssc-term-title' }, t('terminal.title')),
          h('span', { className: 'ssc-mono ssc-term-who' }, who),
          h('span', { className: 'ssc-spacer' }),
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet',
            onClick: () => void create(),
            disabled: busy,
            title: t('terminal.new'),
          }, `+ ${t('terminal.new')}`),
          h('button', {
            type: 'button',
            className: `ssc-btn ssc-btn-quiet ${splitting && orientation === 'row' ? 'ssc-btn-on' : ''}`,
            onClick: () => void split('row'),
            disabled: busy || shown.length === 0,
            title: t('terminal.splitRow'),
          }, '◫'),
          h('button', {
            type: 'button',
            className: `ssc-btn ssc-btn-quiet ${splitting && orientation === 'column' ? 'ssc-btn-on' : ''}`,
            onClick: () => void split('column'),
            disabled: busy || shown.length === 0,
            title: t('terminal.splitColumn'),
          }, '⬒'),
          splitting
            ? h('button', {
              type: 'button',
              className: 'ssc-btn ssc-btn-quiet',
              onClick: unsplit,
              disabled: busy,
            }, t('terminal.unsplit'))
            : null,
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet',
            onClick: () => {
              const target = shown[focused] ?? shown[0]
              if (target !== undefined) void closeTerm(target)
            },
            disabled: busy || shown.length === 0,
          }, t('terminal.close'))),
        failure.length > 0 ? h('div', { className: 'ssc-hint ssc-fail', role: 'alert' }, failure) : null,
        termIds.length > 1
          ? h('div', { className: 'ssc-term-strip' }, termIds.map((termId) => {
            const slot = shown.indexOf(termId)
            return h('span', {
              key: termId,
              className: `ssc-tchip ${slot >= 0 ? 'ssc-tchip-on' : ''} ${slot >= 0 && slot === focused && splitting ? 'ssc-tchip-focus' : ''}`,
              role: 'button',
              tabIndex: 0,
              title: termId,
              onClick: () => show(termId),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  show(termId)
                }
              },
            },
            h('span', { className: 'ssc-mono' }, termId),
            slot < 0 ? null : h('span', { className: 'ssc-tchip-slot' }, slot === 0 ? '①' : '②'),
            h('button', {
              type: 'button',
              className: 'ssc-tchip-close',
              'aria-label': t('terminal.close'),
              disabled: busy,
              onClick: (event) => {
                event.stopPropagation()
                void closeTerm(termId)
              },
            }, '×'))
          }))
          : null,
        termIds.length === 0
          ? h('div', { className: 'ssc-term-empty' },
            h('p', { className: 'ssc-hint' }, t('terminal.none')),
            h('button', { type: 'button', className: 'ssc-btn ssc-btn-primary', onClick: () => void create() }, `+ ${t('terminal.new')}`))
          : h('div', { className: `ssc-term-panes ssc-term-${orientation}` },
            ordered.map((termId) => {
              const slot = shown.indexOf(termId)
              const onScreen = slot >= 0
              return h('div', {
                key: termId,
                className: `ssc-pane ${onScreen && splitting && slot === focused ? 'ssc-pane-focused' : ''}`,
                style: onScreen ? undefined : { display: 'none' },
                onMouseDown: () => {
                  if (onScreen) setFocused(slot)
                },
              }, h(TerminalPane, {
                serverId,
                termId,
                t,
                visible: visible && onScreen,
                focused: onScreen && slot === focused,
              }))
            }),
            spare && !splitting
              ? h('button', {
                type: 'button',
                className: 'ssc-pane-hint',
                onClick: () => void split('row'),
                title: t('terminal.splitRow'),
              }, '+')
              : null))
    }

    /**
     * A centred dialog over a dimmed backdrop.
     *
     * The connection form used to sit inline above the tabs and pushed every
     * panel down while it was open. A dialog keeps the console in place: the
     * backdrop also makes it obvious that the form is modal, and Escape closes it.
     * @param props - title, close handler and the body.
     * @returns the dialog, or null when closed.
     */
    function Modal({ title, onClose, children }) {
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        const previous = document.activeElement
        const panel = panelRef.current
        const focusable = panel?.querySelector('select, input, button')
        ;(focusable ?? panel)?.focus()
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [onClose])

      return h('div', {
        className: 'ssc-scrim',
        onClick: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
      h('div', {
        className: 'ssc-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        tabIndex: -1,
        ref: panelRef,
      },
      h('div', { className: 'ssc-modal-head' },
        h('h3', { className: 'ssc-modal-title' }, title),
        h('button', {
          type: 'button',
          className: 'ssc-modal-close',
          'aria-label': title,
          onClick: onClose,
        }, '×')),
      h('div', { className: 'ssc-modal-body' }, children)))
    }

    /**
     * The connection form: one labelled field per row, so the target, the
     * optional secret and the action each have room.
     * @param props - the catalogue, the current selection and the handlers.
     * @returns the form.
     */
    function Connector({ catalogue, selectedId, password, busy, onSelect, onPassword, onConnect, lead = true, t }) {
      const server = catalogue?.servers.find((entry) => entry.id === selectedId)
      return h('div', { className: 'ssc-connect' },
        lead
          ? h('div', { className: 'ssc-connect-lead' },
            h('h3', { className: 'ssc-connect-title' }, t('connect.title')),
            h('p', { className: 'ssc-connect-sub' }, t('connect.subtitle')))
          : null,
        h('label', { className: 'ssc-field' },
          h('span', { className: 'ssc-field-label' }, t('connect.server')),
          h('select', {
            className: 'ssc-control',
            value: selectedId,
            disabled: busy,
            onChange: (event) => onSelect(event.target.value),
          },
          catalogue === null || catalogue.servers.length === 0
            ? h('option', { value: '' }, t('connect.serverNone'))
            : catalogue.servers.map((entry) => h('option', { key: entry.id, value: entry.id },
              `${entry.label} — ${entry.user === undefined || entry.user === '' ? entry.host : `${entry.user}@${entry.host}`}:${entry.port}`))),
          server === undefined
            ? null
            : h('span', { className: 'ssc-field-hint' }, `${server.host}:${server.port}${
              server.source === 'ssh-config' ? ' · ~/.ssh/config' : ' · plugin config'
            }`)),
        h('label', { className: 'ssc-field' },
          h('span', { className: 'ssc-field-label' }, t('connect.password')),
          h('input', {
            className: 'ssc-control',
            type: 'password',
            value: password,
            autoComplete: 'off',
            placeholder: t('connect.passwordPlaceholder'),
            disabled: busy,
            onChange: (event) => onPassword(event.target.value),
          }),
          h('span', { className: 'ssc-field-hint' }, t('connect.passwordHint'))),
        h('div', { className: 'ssc-actions' },
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-primary',
            onClick: onConnect,
            disabled: busy || selectedId.length === 0,
          }, busy ? t('connect.connecting') : t('connect.action'))))
    }

    /**
     * The page itself, registered as the main panel under the sidebar id.
     * @param props - slot props; `t` is injected by the host's locale seat.
     * @returns the page.
     */
    function SshConsolePage(props) {
      const t = props?.t ?? makeFallbackTranslate(undefined)
      const [catalogue, setCatalogue] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [selectedId, setSelectedId] = React.useState('')
      const [activeId, setActiveId] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [snapshots, setSnapshots] = React.useState({})
      const [tab, setTab] = React.useState('overview')
      const [busy, setBusy] = React.useState(false)
      const [connectorOpen, setConnectorOpen] = React.useState(false)
      const [failure, setFailure] = React.useState('')

      const remember = React.useCallback((serverId) => {
        setSelectedId(serverId)
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, serverId)
        } catch {
          // A blocked storage area only costs the remembered default.
        }
      }, [])

      const refreshSessions = React.useCallback(async () => {
        const value = await call('status', {})
        const next = value.sessions ?? []
        setSessions(next)
        setActiveId((current) => (
          next.some((entry) => entry.serverId === current) ? current : (next[0]?.serverId ?? '')
        ))
        return next
      }, [])

      React.useEffect(() => {
        let alive = true
        Promise.all([call('servers', {}), call('status', {})])
          .then(([nextCatalogue, nextStatus]) => {
            if (!alive) return
            setCatalogue(nextCatalogue)
            const next = nextStatus.sessions ?? []
            setSessions(next)
            setActiveId(next[0]?.serverId ?? '')
            let remembered = ''
            try {
              remembered = typeof localStorage === 'undefined' ? '' : (localStorage.getItem(STORAGE_KEY) ?? '')
            } catch {
              remembered = ''
            }
            const known = nextCatalogue.servers.some((entry) => entry.id === remembered)
            setSelectedId(known ? remembered : (nextCatalogue.servers[0]?.id ?? ''))
          })
          .catch((error) => {
            if (!alive) return
            setFailure(error instanceof Error ? error.message : String(error))
          })
        return () => {
          alive = false
        }
      }, [])

      // Only the host on screen is sampled: with a tab per server the others
      // would be an SSH round trip per interval that nobody is looking at.
      const pollable = tab === 'overview' || tab === 'processes'
      const pollId = pollable ? activeId : ''

      React.useEffect(() => {
        if (pollId.length === 0) return undefined
        let alive = true
        const tick = async () => {
          try {
            const snapshot = await call('metrics', { serverId: pollId })
            if (!alive) return
            setSnapshots((current) => ({ ...current, [pollId]: snapshot }))
          } catch (error) {
            if (!alive) return
            const message = error instanceof Error ? error.message : String(error)
            setSnapshots((current) => ({ ...current, [pollId]: { error: message } }))
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), catalogue?.refreshMs ?? 2000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [pollId, catalogue?.refreshMs])

      const connect = React.useCallback(async () => {
        if (selectedId.length === 0) return
        setBusy(true)
        setFailure('')
        try {
          const request = { serverId: selectedId }
          if (password.length > 0) request.password = password
          await call('connect', request)
          setPassword('')
          setConnectorOpen(false)
          await refreshSessions()
          setActiveId(selectedId)
          remember(selectedId)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [password, refreshSessions, remember, selectedId])

      const disconnect = React.useCallback(async (serverId) => {
        setBusy(true)
        try {
          await call('disconnect', { serverId })
          setSnapshots((current) => {
            const next = { ...current }
            delete next[serverId]
            return next
          })
          await refreshSessions()
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [refreshSessions])

      const connected = sessions.length > 0
      const active = sessions.find((entry) => entry.serverId === activeId)

      // Every connected host keeps a terminal mounted. A hidden one is skipped
      // by layout, so its emulator holds the scrollback without costing a draw.
      const terminalLayers = sessions.map((session) => {
        const server = session.server ?? {}
        const identity = `${server.user === undefined || server.user === '' ? '' : `${server.user}@`}${session.hostname ?? server.host ?? ''}`
        return h(TerminalTab, {
          key: `term:${session.serverId}`,
          serverId: session.serverId,
          who: identity,
          visible: tab === 'terminal' && session.serverId === activeId,
          t,
        })
      })

      // Files are kept the same way, for a different reason: the directory being
      // read is the only state in this panel that costs SSH round trips to
      // rebuild, so it must survive a tab or host switch rather than reset to `~`.
      // A hidden one does no work — nothing here polls.
      const filesLayers = sessions.map((session) => h(FilesTab, {
        key: `files:${session.serverId}`,
        serverId: session.serverId,
        visible: tab === 'files' && session.serverId === activeId,
        t,
      }))

      const header = h('div', { className: 'ssc-head' },
        h('span', { className: 'ssc-head-icon' }, h(ConsoleIcon, { size: 16 })),
        h('h2', { className: 'ssc-title' }, t('panel.title')),
        h('span', { className: 'ssc-spacer' }),
        h('span', { className: `ssc-pill ${connected ? 'ssc-pill-on' : ''}` },
          h('span', { className: 'ssc-dot' }),
          connected ? t('state.connected', { count: sessions.length }) : t('state.idle')))

      if (catalogue !== null && catalogue.servers.length === 0) {
        return h('div', { className: 'ssc-page' },
          header,
          h('div', { className: 'ssc-body' },
            h('div', { className: 'ssc-empty' },
              h(ConsoleIcon, { size: 28 }),
              h('p', { className: 'ssc-empty-title' }, t('empty.title')),
              h('p', { className: 'ssc-empty-body' }, t('empty.body')))))
      }

      const notice = failure.length === 0
        ? null
        : h('div', { className: 'ssc-notice', role: 'alert' },
          h('span', null, failure),
          h('button', {
            type: 'button',
            className: 'ssc-notice-close',
            'aria-label': t('error.dismiss'),
            onClick: () => setFailure(''),
          }, '×'))

      // The form is a dialog while hosts are already open; on the empty state it
      // is the page content, because there is nothing to keep in place.
      const connector = h(Connector, {
        catalogue,
        selectedId,
        password,
        busy,
        onSelect: remember,
        onPassword: setPassword,
        onConnect: () => void connect(),
        lead: !connected,
        t,
      })
      const connectorDialog = connected && connectorOpen
        ? h(Modal, { title: t('connect.title'), onClose: () => setConnectorOpen(false) }, connector)
        : null

      const strip = connected
        ? h('div', { className: 'ssc-strip' },
          h('div', { className: 'ssc-chips' },
            sessions.map((session) => {
              const server = session.server ?? {}
              const label = session.hostname ?? server.label ?? server.host ?? session.serverId
              return h('span', {
                key: session.serverId,
                className: `ssc-chip ${session.serverId === activeId ? 'ssc-chip-on' : ''}`,
                role: 'button',
                tabIndex: 0,
                title: `${server.user === undefined || server.user === '' ? '' : `${server.user}@`}${server.host}:${server.port}`,
                onClick: () => setActiveId(session.serverId),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveId(session.serverId)
                  }
                },
              },
              h('span', { className: 'ssc-dot' }),
              h('span', { className: 'ssc-chip-name' }, label),
              h('button', {
                type: 'button',
                className: 'ssc-chip-close',
                'aria-label': t('connect.disconnect'),
                disabled: busy,
                onClick: (event) => {
                  event.stopPropagation()
                  void disconnect(session.serverId)
                },
              }, '×'))
            })),
          h('span', { className: 'ssc-spacer' }),
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet',
            onClick: () => setConnectorOpen(true),
            disabled: busy,
          }, `+ ${t('connect.add')}`))
        : null

      return h('div', { className: 'ssc-page' },
        header,
        notice,
        strip,
        connectorDialog,
        connected
          ? h(React.Fragment, null,
            h('div', { className: 'ssc-tabs' },
              ['overview', 'processes', 'files', 'terminal'].map((key) => h('button', {
                key,
                type: 'button',
                className: `ssc-tab ${tab === key ? 'ssc-tab-on' : ''}`,
                onClick: () => setTab(key),
              }, t(`tab.${key}`)))),
            h('div', { className: `ssc-body ${tab === 'terminal' ? 'ssc-body-term' : ''}` },
              active === undefined
                ? h('div', { className: 'ssc-hint' }, t('files.loading'))
                : tab === 'overview'
                  ? h(OverviewTab, { key: `overview:${activeId}`, session: active, snapshot: snapshots[activeId] ?? null, t })
                  : tab === 'processes'
                    ? h(ProcessesTab, { key: `processes:${activeId}`, session: active, snapshot: snapshots[activeId] ?? null, t })
                    : null,
              // One mounted file browser per host: leaving the tab hides it and
              // coming back re-reads the directory that is already open, instead
              // of dumping the user back at `~`.
              filesLayers,
              // One mounted terminal per host, kept alive across tab and host
              // switches. Only the selected one is laid out and visible, so the
              // others keep their scrollback without drawing.
              terminalLayers))
          : h('div', { className: 'ssc-body', style: { flex: 'none' } }, connector))
    }

    /* ---------------------------------------------------------------- plugin */

    /** Required Client services: slot registry, locale dictionaries, Remote carrier. */
    const inject = ['slots', 'locale', 'remote']

    /**
     * Build one Remote descriptor whose parameter and result travel as JSON.
     *
     * The descriptor declares exactly the one `input` parameter every Host method
     * takes: the gateway rebuilds the argument object from these fields and
     * rejects a mismatch, so the count must track the Host signature.
     * @param method - Host method name.
     * @returns the descriptor.
     */
    function descriptorFor(method) {
      const endpoint = `${PKG}#${method}`
      return {
        id: endpoint,
        service: SERVICE_KEY,
        namespace: SERVICE_KEY,
        method,
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'input',
          wire: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${endpoint}:input`,
            create: () => z.any(),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: `${endpoint}:result`,
          create: () => z.any(),
        },
      }
    }

    /**
     * Mount the Remote namespace, bind it, then register the sidebar icon and the
     * panel. The namespace is a Client service created by the mount, so it is
     * reached through `ctx.inject` — `ctx.get` refuses a key the plugin did not
     * declare.
     * @param ctx - Client plugin context.
     */
    async function apply(ctx) {
      const carrier = ctx.get('remote')
      if (carrier === undefined) throw new Error('ssh-console: the Remote carrier service is unavailable')
      const unmountRemote = await carrier.$mount({
        package: PKG,
        descriptors: [
          descriptorFor('servers'),
          descriptorFor('connect'),
          descriptorFor('disconnect'),
          descriptorFor('status'),
          descriptorFor('listDir'),
          descriptorFor('readText'),
          descriptorFor('metrics'),
          descriptorFor('exec'),
          descriptorFor('termOpen'),
          descriptorFor('termList'),
          descriptorFor('termRead'),
          descriptorFor('termWrite'),
          descriptorFor('termResize'),
          descriptorFor('termClose'),
        ],
      })

      const binding = ctx.inject([`remote.${SERVICE_KEY}`], (remoteCtx) => {
        api = remoteCtx.remote[SERVICE_KEY]
        remoteCtx.effect(() => () => {
          api = undefined
        }, 'ssh-console: namespace binding')
      })

      ctx.effect(() => () => {
        try {
          binding?.dispose?.()
        } catch {
          // A binding that never activated needs no teardown.
        }
        void unmountRemote()
      }, 'ssh-console: remote namespace')
      ctx.effect(insertStyles, 'ssh-console: stylesheet')
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'ssh-console: dictionaries')

      const fallback = makeFallbackTranslate(ctx.locale)
      const label = () => {
        try {
          return fallback('panel.title')
        } catch {
          return 'SSH Console'
        }
      }

      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'ssh-console',
          order: 20,
          label,
          locale: LOCALE_NS,
        }, ConsolePanelIcon)
      })
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({
          name: 'main',
          key: 'ssh-console',
          locale: LOCALE_NS,
        }, SshConsolePage)
      })
    }

    return { apply, inject }
  },
})
