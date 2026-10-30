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

    /**
     * The directory each server was last showing, keyed by server id.
     *
     * This lives outside the component on purpose. Closing the panel unmounts the
     * page, and with it the file browser, so every reopen started over at the home
     * directory — the one piece of state a person expects to survive, because
     * getting back to a deep directory costs a walk. A module-level map outlives
     * the component without writing remote paths into browser storage.
     */
    const LAST_DIR = new Map()

    /**
     * The last metrics snapshot each server reported, kept outside the component.
     *
     * The SSH connection is long-lived — the Host holds one per server for as long
     * as the app runs — but the numbers on screen were React state, so closing the
     * panel threw them away and every reopen blanked to "loading" for the length
     * of a round trip. Sampling takes about 750 ms here, which is long enough to
     * read as a stall rather than a refresh.
     *
     * A cached value is shown immediately and marked as being refreshed, so the
     * panel never claims old numbers are current.
     */
    const SNAPSHOT_CACHE = new Map()

    /**
     * The last directory listing each server produced, kept for the same reason.
     *
     * Reopening the panel re-reads the directory anyway — that is what makes the
     * listing current — but a read takes about 190 ms, and blanking the file list
     * for that long on every reopen reads as a reload rather than a refresh.
     */
    const LISTING_CACHE = new Map()

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
/* Server form rows. The alias gets the wide column and the port a narrow one,
   because that is the shape of the data: one long name, one short number. */
.ssc-field-row{display:flex;align-items:flex-end;gap:8px;min-width:0}
.ssc-field-grow{flex:1;min-width:0}
.ssc-field-inline{flex:1;min-width:0}
/* The mode switch shares a line with the picker's label, in the same slot for both
   modes, so it reads as belonging to the picker rather than the save/delete row.
   It wears the panel's own quiet-button style rather than a link: an underlined text
   link was the only hyperlink in the whole surface and looked like page furniture
   that had wandered into a form. */
.ssc-picker-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.ssc-picker-head .ssc-btn{flex:none;height:24px;padding:0 9px;font-size:12px}
.ssc-new-badge{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
/* The description stands in for the server <select>, so it takes the same height as
   a control. Without that, switching modes shifted every field below it by ~19px —
   measured, not guessed — which made the form feel like it was jumping. */
.ssc-new-sub{display:flex;align-items:center;min-height:34px;font-size:12px;
  color:var(--dsw-alias-label-secondary);min-width:0}
.ssc-control-narrow{width:84px;flex:none}
.ssc-field-label{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500}
.ssc-field-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.ssc-control{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none}
.ssc-control:focus{border-color:var(--dsw-alias-brand-primary)}
.ssc-control:disabled{opacity:.55}
select.ssc-control{appearance:none;padding-right:26px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 15px) 15px,calc(100% - 10px) 15px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.ssc-actions{display:flex;align-items:center;gap:8px}
/* Removal sits at the far end, away from the buttons that keep or create. */
.ssc-actions-end{margin-left:auto}

/* buttons */
.ssc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.ssc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ssc-btn:disabled{opacity:.45;cursor:not-allowed}
.ssc-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:500}
.ssc-btn-primary:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-brand-primary)}
.ssc-btn-quiet{height:26px;padding:0 10px;font-size:12px}
/* Destructive actions sit in the same row as the others, so they keep the same
   box: shrinking one button to signal danger reads as a layout bug, not a
   warning. The colour carries the distinction instead. */
.ssc-btn-danger{color:var(--dsw-alias-state-error-primary)}
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
/* Host-key confirmation: the fingerprint is the only thing being compared, so it
   gets its own line at a size that can be read aloud character by character. */
.ssc-trust{display:flex;flex-direction:column;gap:12px}
.ssc-trust-lead{margin:0;font-size:12.5px;line-height:19px}
.ssc-trust-list{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.ssc-trust-list dt{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px}
.ssc-trust-list dd{margin:0;font-size:11.5px;overflow-wrap:anywhere}
.ssc-trust-fp{font-weight:600;user-select:all}
.ssc-trust-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
.ssc-trust-actions{display:flex;justify-content:flex-end;gap:8px}

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
/* The heading is also the fold control, so it is a button that looks like a
   heading: no chrome until hover, then the row shows it is pressable. */
.ssc-section-toggle{width:100%;padding:4px 6px;margin:0 0 8px;border:0;border-radius:6px;background:transparent;color:inherit;font-family:inherit;text-align:left;cursor:pointer;align-items:center}
.ssc-section-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ssc-section-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* Large enough to read at a glance and to look like something you can press:
   at 9px the caret was a speck that read as decoration rather than a control. */
.ssc-caret{display:inline-block;flex:none;width:14px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;text-align:center;transition:transform .12s ease}
.ssc-caret-open{transform:rotate(90deg)}
/* Per-card fold control inside the GPU process table. */
.ssc-group-toggle{display:flex;align-items:center;gap:6px;width:100%;padding:2px 0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ssc-group-toggle:hover .ssc-caret{color:var(--dsw-alias-label-primary)}
.ssc-group-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.ssc-section-title{margin:0;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;text-transform:uppercase}
.ssc-section-count{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
/* Marks numbers that came from the last sample while a fresh one is on its way. */
.ssc-stale{display:inline-flex;align-items:center;gap:5px;margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:11px}
.ssc-stale::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);animation:ssc-pulse 1s ease-in-out infinite}
@keyframes ssc-pulse{0%,100%{opacity:.25}50%{opacity:1}}
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
.ssc-path{display:flex;align-items:center;gap:6px;margin-bottom:12px}
/* A square, quiet button for the toolbar glyphs: ↑ ~ ✎ ⟳ */
.ssc-path-btn{flex:none;width:28px;height:28px;padding:0;justify-content:center;font-size:13px;line-height:1}
.ssc-crumbs{flex:1;min-width:0;display:flex;align-items:center;gap:2px;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow-x:auto;overflow-y:hidden;white-space:nowrap;cursor:text;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.ssc-crumbs::-webkit-scrollbar{height:4px}
.ssc-crumbs::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:2px}
.ssc-crumbs::-webkit-scrollbar-track{background:transparent}
.ssc-crumb-wrap{display:inline-flex;align-items:center;gap:2px;flex:none}
.ssc-crumb-sep{color:var(--dsw-alias-label-secondary);font-size:11px;opacity:.7}
.ssc-crumb{flex:none;padding:2px 5px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;cursor:pointer;line-height:1.3}
.ssc-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* The directory on screen reads as the current one, not as another link. */
.ssc-crumb-on{color:var(--dsw-alias-label-primary);font-weight:600}
.ssc-path-input{flex:1;min-width:0;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-brand-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;outline:none}
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
/* Scrollback search bar: floats over the top-right of the pane, because it is a
   temporary overlay and must not reflow the grid the PTY is sized against. */
.ssc-search{position:absolute;top:6px;right:6px;z-index:3;display:flex;align-items:center;gap:4px;padding:4px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);box-shadow:0 4px 14px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.ssc-search-input{width:150px;padding:2px 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px}
.ssc-search-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ssc-search-count{min-width:0;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:14px;white-space:nowrap}
.ssc-search-step,.ssc-search-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer}
.ssc-search-step:hover:not(:disabled),.ssc-search-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ssc-search-step:disabled{opacity:.4;cursor:default}
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
      'trust.title': '确认主机密钥',
      'trust.lead': '第一次连接到 {host}:{port}。请核对下面的指纹与服务器一致，确认后才会发送凭据。',
      'trust.keyType': '密钥类型',
      'trust.fingerprint': '指纹',
      'trust.file': '保存到',
      'trust.hint': '指纹不符时不要接受。若服务器确实更换过密钥，请自行删除 known_hosts 里的旧条目。',
      'trust.accept': '信任并连接',
      'trust.cancel': '取消',
      'trust.unavailable': '无法校验主机密钥，因此没有发送任何凭据：{reason}',
      'trust.mismatch': '{host} 出示的主机密钥与 {file} 中记录的不一致。这可能是中间人攻击，已拒绝连接。',
      'trust.revoked': '{host} 出示的主机密钥在 {file} 中已被标记为吊销，已拒绝连接。',
      'terminal.search': '搜索回滚内容',
      'terminal.searchPlaceholder': '搜索（Ctrl+F）',
      'terminal.searchPrev': '上一处',
      'terminal.searchNext': '下一处',
      'terminal.searchClose': '关闭搜索',
      'terminal.searchNone': '无匹配',
      'terminal.searchCount': '{index}/{count}',
      'terminal.searchCountOf': '{count} 处',
      'server.new': '新建',
      'server.newHint': '清空表单，填写一台新的服务器',
      'server.label': '别名',
      'server.labelPlaceholder': '例如 A100服务器（不能有空格）',
      'server.host': '主机 / IP',
      'server.hostPlaceholder': '例如 122.205.68.212',
      'server.port': '端口',
      'server.user': '用户名',
      'server.identityFile': '密钥文件（可选）',
      'server.identityFilePlaceholder': '留空则用 ~/.ssh 下的默认密钥',
      'server.save': '保存',
      'server.saveHint': '写入 ~/.ssh/config',
      'server.remove': '删除',
      'server.removeHint': '从 ~/.ssh/config 里删掉这一节',
      'server.removeConfirm': '从 ~/.ssh/config 删除「{label}」？这个操作不可撤销。',
      'server.fromConfig': '来自 {file}',
      'server.fromPlugin': '来自插件配置（只读）',
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
      'files.back': '返回上一次所在目录',
      'files.forward': '前进到下一个目录',
      'files.home': '主目录',
      'files.edit': '输入路径',
      'files.pathHint': '输入绝对路径，或 ~ 开头的路径，回车跳转',
      'files.refresh': '刷新',
      'files.loading': '加载中…',
      'refreshing': '正在刷新…',
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
      'trust.title': 'Confirm host key',
      'trust.lead': 'First connection to {host}:{port}. Compare the fingerprint below with the server; credentials are sent only after you accept.',
      'trust.keyType': 'Key type',
      'trust.fingerprint': 'Fingerprint',
      'trust.file': 'Saved to',
      'trust.hint': 'Do not accept a fingerprint that disagrees with the server. If its key really was replaced, remove the old entry from known_hosts yourself.',
      'trust.accept': 'Trust and connect',
      'trust.cancel': 'Cancel',
      'trust.unavailable': 'The host key could not be checked, so no credentials were sent: {reason}',
      'trust.mismatch': '{host} presented a host key that does not match {file}. This is what an intercepted connection looks like; the connection was refused.',
      'trust.revoked': '{host} presented a host key that {file} marks as revoked; the connection was refused.',
      'terminal.search': 'Search scrollback',
      'terminal.searchPlaceholder': 'Search (Ctrl+F)',
      'terminal.searchPrev': 'Previous match',
      'terminal.searchNext': 'Next match',
      'terminal.searchClose': 'Close search',
      'terminal.searchNone': 'No match',
      'terminal.searchCount': '{index}/{count}',
      'terminal.searchCountOf': '{count} matches',
      'server.new': 'New',
      'server.newHint': 'Clear the form and enter a new server',
      'server.label': 'Alias',
      'server.labelPlaceholder': 'e.g. A100-lab (no spaces)',
      'server.host': 'Host / IP',
      'server.hostPlaceholder': 'e.g. 122.205.68.212',
      'server.port': 'Port',
      'server.user': 'User',
      'server.identityFile': 'Identity file (optional)',
      'server.identityFilePlaceholder': 'Leave blank to use the default key in ~/.ssh',
      'server.save': 'Save',
      'server.saveHint': 'Write to ~/.ssh/config',
      'server.remove': 'Remove',
      'server.removeHint': 'Delete this block from ~/.ssh/config',
      'server.removeConfirm': 'Delete "{label}" from ~/.ssh/config? This cannot be undone.',
      'server.fromConfig': 'from {file}',
      'server.fromPlugin': 'from plugin config (read-only)',
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
      'files.back': 'Back to the previous directory',
      'files.forward': 'Forward to the next directory',
      'files.home': 'Home directory',
      'files.edit': 'Type a path',
      'files.pathHint': 'An absolute path, or one starting with ~, then press Enter',
      'files.refresh': 'Refresh',
      'files.loading': 'Loading…',
      'refreshing': 'Refreshing…',
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
    function HostBlock({ session, snapshot, stale, t }) {
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
              endpointOf(server),
              typeof session.since === 'number' ? t('since', { duration: formatDuration(Date.now() - session.since) }) : null,
            ].filter(Boolean).join(' · ')),
          // Cached numbers are shown straight away but labelled, so a reopened
          // panel never presents a minutes-old reading as if it were live.
          stale === true ? h('span', { className: 'ssc-stale' }, t('refreshing')) : null),
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
    function OverviewTab({ session, snapshot, stale, t }) {
      return h(HostBlock, { session, snapshot, stale, t })
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
    /**
     * A section heading that collapses the table beneath it.
     *
     * A busy GPU host runs dozens of processes; on the processes tab the tables
     * for five cards plus the CPU list are longer than any screen, and the part a
     * person is looking for is usually one of them. Folding the rest away is what
     * makes that reachable without scrolling past it.
     *
     * The control is a button, so it is reachable and operable from the keyboard,
     * and it reports its state through `aria-expanded` rather than relying on the
     * chevron alone.
     * @param props - the title, the summary shown while collapsed, the open state
     *   and the toggle handler.
     * @returns the heading row.
     */
    function SectionHead({ title, summary, open, onToggle }) {
      return h('button', {
        type: 'button',
        className: 'ssc-section-head ssc-section-toggle',
        onClick: onToggle,
        'aria-expanded': open ? 'true' : 'false',
        title,
      },
      h('span', { className: `ssc-caret ${open ? 'ssc-caret-open' : ''}`, 'aria-hidden': 'true' }, '▸'),
      h('h4', { className: 'ssc-section-title' }, title),
      summary === undefined || summary === null
        ? null
        : h('span', { className: 'ssc-section-count' }, summary))
    }

    /**
     * The GPU processes of one host: which card, whose process, and its command.
     *
     * The command is shown in full and allowed to wrap. Shortening it dropped the
     * interpreter and the script — exactly the part that says what the job is.
     *
     * Rows are grouped by card with a heading per group: a busy host runs dozens
     * of compute processes, and a flat list makes "what is on #3" a scan instead
     * of a glance. Each card's group folds independently, and the whole table
     * folds from its own heading.
     * @param props - the rows and the locale lookup.
     * @returns the table, or null when the host reports none.
     */
    function GpuProcessTable({ rows, t }) {
      const [open, setOpen] = React.useState(true)
      const [collapsed, setCollapsed] = React.useState(() => new Set())
      if (rows.length === 0) return null

      const groups = new Map()
      for (const process of rows) {
        const key = process.gpuIndex === undefined ? -1 : process.gpuIndex
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(process)
      }
      const keys = [...groups.keys()].sort((left, right) => left - right)

      const toggleGroup = (key) => {
        setCollapsed((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      const bodies = keys.map((key) => {
        const mine = groups.get(key)
        const total = mine.reduce((sum, process) => sum + (process.usedMiB ?? 0), 0)
        const folded = collapsed.has(key)
        return h('tbody', { key: `gpu-${key}` },
          h('tr', { className: 'ssc-group-row' },
            h('th', { className: 'ssc-group', colSpan: 5, scope: 'rowgroup' },
              h('button', {
                type: 'button',
                className: 'ssc-group-toggle',
                onClick: () => toggleGroup(key),
                'aria-expanded': folded ? 'false' : 'true',
              },
              h('span', { className: `ssc-caret ${folded ? '' : 'ssc-caret-open'}`, 'aria-hidden': 'true' }, '▸'),
              h('span', { className: 'ssc-mono' }, key < 0 ? '—' : `#${key}`),
              h('span', { className: 'ssc-group-meta' },
                `${t('gpu.procs', { count: mine.length })} · ${formatBytes(total * 2 ** 20)}`)))),
          folded
            ? null
            : mine.map((process) => h('tr', { key: `${key}-${process.pid}` },
              h('td', { className: 'ssc-num ssc-mono' }, key < 0 ? '—' : `#${key}`),
              h('td', { className: 'ssc-num ssc-mono' }, process.pid),
              h('td', null, process.user ?? '—'),
              h('td', { className: 'ssc-num' }, formatBytes((process.usedMiB ?? 0) * 2 ** 20)),
              h('td', { className: 'ssc-mono ssc-cmd', title: process.command }, process.command ?? '—'))))
      })

      return h('div', { className: 'ssc-section' },
        h(SectionHead, {
          title: t('gpu.processes'),
          summary: `${t('gpu.procs', { count: rows.length })} · ${keys.length} GPU`,
          open,
          onToggle: () => setOpen((current) => !current),
        }),
        open
          ? h('div', { className: 'ssc-table-wrap' },
            h('table', { className: 'ssc-table ssc-table-wide' },
              h('thead', null, h('tr', null,
                h('th', { className: 'ssc-num' }, t('col.gpu')),
                h('th', { className: 'ssc-num' }, t('col.pid')),
                h('th', null, t('col.user')),
                h('th', { className: 'ssc-num' }, t('gpu.memory')),
                h('th', { className: 'ssc-cmd' }, t('col.command')))),
              bodies))
          : null)
    }

    /**
     * The top processes of one host, with the columns that make a busy GPU host
     * readable: resident memory, thread count and how long it has been running.
     * Folds from its heading, like the GPU table above it.
     * @param props - the rows and the locale lookup.
     * @returns the table.
     */
    function ProcessTable({ rows, t }) {
      const [open, setOpen] = React.useState(true)
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
        h(SectionHead, {
          title: t('processes'),
          summary: String(rows.length),
          open,
          onToggle: () => setOpen((current) => !current),
        }),
        open
          ? h('div', { className: 'ssc-table-wrap' },
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
              h('tbody', null, body)))
          : null)
    }

    /**
     * The processes tab: the selected host only.
     *
     * Same rule as the overview — one host at a time, chosen by the chip strip,
     * so the tables never scroll past a second machine's heading.
     * @param props - the selected session, its snapshot, whether that snapshot
     *   came from the cache, and the locale lookup.
     * @returns the tab body.
     */
    function ProcessesTab({ session, snapshot, stale, t }) {
      if (snapshot === null || snapshot === undefined) {
        return h('div', { className: 'ssc-hint' }, t('files.loading'))
      }
      if (typeof snapshot.error === 'string') {
        return h('div', { className: 'ssc-hint ssc-fail' }, `${t('poll.failed')}: ${snapshot.error}`)
      }
      const gpuRows = snapshot.gpuProcesses ?? []
      const rows = snapshot.processes ?? []
      return h(React.Fragment, null,
        // The lists below came from the last sample, not this mount's first read.
        stale === true ? h('div', { className: 'ssc-stale' }, t('refreshing')) : null,
        h(GpuProcessTable, { rows: gpuRows, t }),
        rows.length === 0
          ? h('div', { className: 'ssc-hint' }, t('processes.empty'))
          : h(ProcessTable, { rows, t }))
    }

    /**
     * Decide what the pane list should become after terminals come and go.
     *
     * Kept as a plain function rather than inline in the effect so it can be run
     * directly: this is the arithmetic that decides whether a surviving terminal
     * is laid out or silently hidden, which is the difference between "closing one
     * of two kept one open" and "closing one of two closed both".
     * @param termIds - every terminal the host still has.
     * @param panes - the terminals currently laid out.
     * @returns the repaired list, or null when the current one is already right.
     */
    function repairPanes(termIds, panes) {
      if (termIds.length === 0) return panes.length > 0 ? [] : null
      // A pane pointing at a closed terminal must be replaced in state, not just
      // filtered at render time: the survivor stays mounted but gets no slot, so
      // it is laid out nowhere and the tab looks empty.
      if (panes.length === 0) return [termIds[0]]
      if (panes.every((id) => termIds.includes(id))) return null
      const surviving = panes.filter((id) => termIds.includes(id))
      return surviving.length > 0 ? surviving : [termIds[0]]
    }

    /**
     * The panes to lay out right now, before the repair effect catches up.
     *
     * A close drops the id from both lists in one commit, leaving no pane for the
     * survivor. Falling back to the first live terminal means a close never paints
     * a blank frame between the state change and the effect that follows it.
     * @param termIds - every terminal the host still has.
     * @param panes - the terminals currently laid out.
     * @returns the ids to lay out, in order.
     */
    function shownPanes(termIds, panes) {
      const live = panes.filter((id) => termIds.includes(id))
      return live.length > 0 || termIds.length === 0 ? live : [termIds[0]]
    }

    /**
     * Split an absolute path into one breadcrumb entry per level.
     *
     * Every level gets its own entry carrying the absolute path it stands for,
     * so any depth is a single click away rather than one `cd ..` per level.
     *
     * The trail always spells out the real path, `/` first. Collapsing a prefix
     * under the home directory into a single `~` entry was tried and is worse for
     * exactly the case this control exists for: on `/home/yz/lq/test1` it renders
     * `~ › lq › test1`, which makes `/home` and `/yz` unreachable, and it hides
     * where the directory actually is. A separate toolbar button still offers
     * `~` for jumping home, where the shorthand costs nothing.
     * @param path - the absolute path currently listed.
     * @returns the entries, root first.
     */
    function buildCrumbs(path) {
      const entries = [{ name: '/', path: '/', full: '/' }]
      const current = String(path).replace(/\/+$/u, '')
      // Before the first listing arrives `path` is not yet absolute, and a
      // relative value would otherwise render as a bogus clickable `~` entry
      // pointing at `/~`. The root alone is the honest thing to show.
      if (!current.startsWith('/')) return entries
      let accumulated = ''
      for (const part of current.split('/')) {
        if (part.length === 0) continue
        accumulated = `${accumulated}/${part}`
        entries.push({ name: part, path: accumulated, full: accumulated })
      }
      return entries
    }

    /**
     * How many directories the files tab remembers for Back and Forward.
     *
     * Generous enough to cover a real session's worth of wandering, bounded so a
     * panel left open for days cannot grow the list without limit.
     */
    const MAX_HISTORY = 50
    /**
     * A blank server form.
     *
     * Frozen so a reset cannot accidentally share an object across states, and the
     * port starts as text because the field is typed into before it is parsed.
     */
    const EMPTY_DRAFT = Object.freeze({ label: '', host: '', port: '22', user: '', identityFile: '' })
    /** Turn a catalogue entry back into form text. */
    function draftFrom(entry) {
      return {
        label: entry.label,
        host: entry.host,
        port: String(entry.port),
        user: entry.user ?? '',
        identityFile: entry.identityFile ?? '',
      }
    }

    /**
     * Whether the history has somewhere to go backwards to.
     *
     * Small enough to inline, but kept as a named rule so it can be run directly:
     * the buttons must reflect the cursor, and "there is an entry before this one"
     * is a statement worth checking rather than pattern-matching in a test.
     * @param history - the current `{ entries, index }`.
     * @returns true when Back should be enabled.
     */
    function canGoBack(history) {
      return history.index > 0
    }

    /**
     * Whether the history has somewhere to go forwards to.
     * @param history - the current `{ entries, index }`.
     * @returns true when Forward should be enabled.
     */
    function canGoForward(history) {
      return history.index >= 0 && history.index < history.entries.length - 1
    }

    /**
     * Append a directory to the browsing history, after the cursor.
     *
     * Navigating away from a position discards whatever was ahead of it, which is
     * what every browser and file manager does: the entries forward of the cursor
     * described a future the user just chose not to take. Re-reading the directory
     * already at the cursor is not a new entry, so a refresh cannot fill the
     * history with repeats.
     *
     * The list is capped, dropping the oldest entries. A long session could
     * otherwise grow it without bound, and nobody walks back a hundred jumps.
     * @param history - the current `{ entries, index }`.
     * @param path - the resolved absolute path that was just read.
     * @returns the next history; the same object when nothing changed.
     */
    function pushHistory(history, path) {
      if (path.length === 0) return history
      if (history.entries[history.index] === path) return history
      const kept = history.entries.slice(0, history.index + 1)
      const entries = [...kept, path]
      if (entries.length > MAX_HISTORY) {
        const dropped = entries.length - MAX_HISTORY
        return { entries: entries.slice(dropped), index: entries.length - dropped - 1 }
      }
      return { entries, index: entries.length - 1 }
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
      // Empty until the first listing answers with a resolved absolute path; the
      // breadcrumb shows just the root meanwhile rather than a guess.
      const [path, setPath] = React.useState(() => LAST_DIR.get(serverId) ?? '')
      // Start from the last listing this server produced, so reopening the panel
      // shows the directory immediately instead of blanking for a round trip.
      const [listing, setListing] = React.useState(() => LISTING_CACHE.get(serverId) ?? null)
      const [loading, setLoading] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [preview, setPreview] = React.useState(null)
      const [previewLoading, setPreviewLoading] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      // Browsing history, like a file manager's back/forward. Entries and the
      // cursor live in one object: as two pieces of state the cursor could be
      // committed against a list that had already been replaced in the same
      // batch, and the two would drift.
      const [history, setHistory] = React.useState({ entries: [], index: -1 })
      const inputRef = React.useRef(null)
      const crumbsRef = React.useRef(null)

      // The directory currently listed, as the server resolved it. Kept in a ref
      // so the visibility effect can re-read it without depending on `path`,
      // which would re-run on every navigation.
      const listedRef = React.useRef(LAST_DIR.get(serverId) ?? '')

      /**
       * Read one directory and, on success, place it in the history.
       *
       * The path committed to history is the resolved one the server returns,
       * not what was asked for: `~` and `a/../b` arrive back as absolute paths,
       * and history must hold only the form the breadcrumb can render.
       *
       * `where` is applied only after the read succeeds. A jump to a directory
       * that has since been deleted reports the error and leaves the cursor
       * untouched, so Back still leads somewhere that exists.
       * @param next - the path to ask for.
       * @param where - how this read relates to the history. Omitted for a plain
       *   refresh, which must not add an entry; the string `'push'` for a new
       *   navigation; a number to move the cursor to that index, which is what
       *   Back and Forward do.
       */
      const load = React.useCallback(async (next, where) => {
        setLoading(true)
        setFailure('')
        try {
          const value = await call('listDir', { serverId, path: next })
          setListing(value)
          setPath(value.path)
          listedRef.current = value.path
          LAST_DIR.set(serverId, value.path)
          LISTING_CACHE.set(serverId, value)
          if (where === undefined) return
          if (typeof where === 'number') {
            setHistory((current) => ({ entries: current.entries, index: where }))
          } else {
            setHistory((current) => pushHistory(current, value.path))
          }
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
          setListing(null)
        } finally {
          setLoading(false)
        }
      }, [serverId])

      // One request when this tab is first shown, and one each time it is shown
      // again. This used to be two effects, which raced on the first visit: the
      // mount effect started a read of the home directory and the visibility
      // effect immediately read the same one, because the first response had not
      // landed and `path` was still the unresolved `~`.
      const loadedRef = React.useRef(false)
      React.useEffect(() => {
        if (!visible) return
        if (!loadedRef.current) {
          loadedRef.current = true
          // Reopening the panel remounts this component. Starting at home every
          // time would throw away the directory the user was reading, so resume
          // where this server was left — if that directory has since gone, the
          // read fails visibly and the home button is one click away.
          const remembered = LAST_DIR.get(serverId)
          void load(remembered === undefined ? '~' : remembered, 'push')
          return
        }
        // Coming back re-reads the directory already on screen, so what is shown
        // is current without moving the user. If the first attempt never
        // succeeded there is nothing to return to, so try home again. This is a
        // refresh, not a navigation, so it passes no `where` and leaves the
        // history alone.
        void load(listedRef.current.length > 0 ? listedRef.current : '~')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [visible])

      const join = React.useCallback((base, name) => (base.endsWith('/') ? `${base}${name}` : `${base}/${name}`), [])

      const openEntry = React.useCallback((entry) => {
        if (entry.kind === 'directory') {
          void load(join(path, entry.name), 'push')
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

      // The breadcrumb: the real path, one clickable entry per level.
      const crumbs = React.useMemo(() => buildCrumbs(path), [path])

      const beginEdit = React.useCallback(() => {
        setDraft(path)
        setEditing(true)
      }, [path])

      const cancelEdit = React.useCallback(() => {
        setEditing(false)
        setDraft('')
      }, [])

      const commitEdit = React.useCallback(() => {
        const next = draft.trim()
        setEditing(false)
        setDraft('')
        // An empty box or the path already shown is not a navigation; re-reading
        // the same directory would only add a round trip for nothing.
        if (next.length === 0 || next === path) return
        setPreview(null)
        void load(next, 'push')
      }, [draft, path, load])

      // Back and Forward. Each reads the neighbouring entry and moves the cursor
      // to it, so stepping back and forward again is symmetric and a step never
      // appends anything.
      const canBack = canGoBack(history)
      const canForward = canGoForward(history)

      const step = React.useCallback((delta) => {
        // Read from the state captured by this render, not from inside a setState
        // updater: an updater must be pure, and starting a request from one would
        // double up wherever React invokes it twice to check.
        const target = history.index + delta
        if (target < 0 || target >= history.entries.length) return
        setPreview(null)
        void load(history.entries[target], target)
      }, [history, load])

      // Focus and select on entering edit mode, so typing replaces the path and
      // Escape-then-reopen never leaves a stale selection.
      React.useEffect(() => {
        if (!editing) return
        const input = inputRef.current
        if (input === null || input === undefined) return
        input.focus()
        input.select()
      }, [editing])

      // A deep path overflows the bar; keep the crumb for the directory actually
      // being shown in view rather than the root end.
      React.useEffect(() => {
        const bar = crumbsRef.current
        if (bar === null || bar === undefined) return
        bar.scrollLeft = bar.scrollWidth
      }, [crumbs])

      return h('div', {
        className: 'ssc-files',
        style: visible ? undefined : { display: 'none' },
      },
      h('div', { className: 'ssc-path' },
          // Back and Forward come first: they are the cheapest way to undo a
          // wrong turn, and they sit where a browser puts them.
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet ssc-path-btn',
            onClick: () => step(-1),
            disabled: loading || !canBack,
            title: t('files.back'),
            'aria-label': t('files.back'),
          }, '←'),
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet ssc-path-btn',
            onClick: () => step(1),
            disabled: loading || !canForward,
            title: t('files.forward'),
            'aria-label': t('files.forward'),
          }, '→'),
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet ssc-path-btn',
            onClick: () => void load(parentPath, 'push'),
            disabled: loading,
            title: t('files.up'),
            'aria-label': t('files.up'),
          }, '↑'),
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet ssc-path-btn',
            onClick: () => void load('~', 'push'),
            disabled: loading,
            title: t('files.home'),
            'aria-label': t('files.home'),
          }, '~'),
          editing
            ? h('input', {
              className: 'ssc-path-input',
              ref: inputRef,
              value: draft,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: t('files.pathHint'),
              title: t('files.pathHint'),
              'aria-label': t('files.edit'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelEdit()
                }
                // Keep the keystroke local. The only document-level Escape
                // listener today belongs to the connect dialog, which cannot be
                // open at the same time as a focusable address bar; this guards
                // the intent rather than a live collision.
                event.stopPropagation()
              },
              onBlur: cancelEdit,
            })
            : h('div', {
              className: 'ssc-crumbs',
              ref: crumbsRef,
              onClick: beginEdit,
              title: t('files.edit'),
            },
            crumbs.map((crumb, index) => h('span', { key: crumb.full, className: 'ssc-crumb-wrap' },
              index === 0 ? null : h('span', { className: 'ssc-crumb-sep', 'aria-hidden': 'true' }, '›'),
              h('button', {
                type: 'button',
                className: `ssc-crumb ${index === crumbs.length - 1 ? 'ssc-crumb-on' : ''}`,
                onClick: (event) => {
                  // The bar underneath opens the editor; a crumb click navigates.
                  event.stopPropagation()
                  if (crumb.path === path) return
                  setPreview(null)
                  void load(crumb.path, 'push')
                },
                title: crumb.full,
              }, crumb.name)))),
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet ssc-path-btn',
            onClick: beginEdit,
            title: t('files.edit'),
            'aria-label': t('files.edit'),
          }, '✎'),
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-quiet ssc-path-btn',
            onClick: () => void load(path),
            disabled: loading,
            title: t('files.refresh'),
            'aria-label': t('files.refresh'),
          }, '⟳')),
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
        return {
          background: readThemeColor('--dsw-alias-bg-layer-1') ?? fallback.background,
          foreground: readThemeColor('--dsw-alias-label-primary') ?? fallback.foreground,
          cursor: readThemeColor('--dsw-alias-brand-primary') ?? fallback.cursor,
          selectionBackground: readThemeColor('--dsw-alias-interactive-bg-hover') ?? fallback.selectionBackground,
        }
      } catch {
        return fallback
      }
    }

    /**
     * Read one theme token as a colour the renderer can paint.
     *
     * Both callers need a literal colour rather than a `var(...)` string: xterm
     * draws the screen to a canvas, and the search addon parses its decoration
     * colours itself.
     * @param token - the custom property, including the leading `--`.
     * @returns the declared value, or undefined when it is absent or unusable.
     */
    function readThemeColor(token) {
      if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return undefined
      const style = getComputedStyle(document.body)
      const value = style.getPropertyValue(token).trim()
      if (value.length === 0) return undefined
      // A token holding a gradient or an unsupported function would leave the
      // screen unthemed, so it is rejected rather than passed through.
      const supported = typeof CSS === 'undefined' || typeof CSS.supports !== 'function'
        || CSS.supports('color', value)
      return supported ? value : undefined
    }

    /**
     * Turn one hex colour from a search option into `#RRGGBBAA`.
     *
     * xterm's decoration API only accepts `#RRGGBB[AA]`: it parses the string
     * itself rather than handing it to CSS, so a token or a `color-mix()` would be
     * rejected outright and the match would simply not be painted. The alpha
     * channel is what keeps the glyphs under the highlight readable, so it is
     * computed here from a coverage value instead of being written out by hand.
     * @param hex - `#RGB`, `#RRGGBB` or `#RRGGBBAA`.
     * @param alpha - coverage from 0 to 1, used only when `hex` carries none.
     * @returns the eight-digit form, or undefined when the input is not hex.
     */
    function withAlpha(hex, alpha) {
      if (typeof hex !== 'string') return undefined
      const raw = hex.trim().replace(/^#/u, '')
      if (/^[\da-f]{3}$/iu.test(raw)) {
        const full = raw.split('').map((digit) => digit + digit).join('')
        return `#${full}${toAlphaByte(alpha)}`
      }
      if (/^[\da-f]{6}$/iu.test(raw)) return `#${raw}${toAlphaByte(alpha)}`
      if (/^[\da-f]{8}$/iu.test(raw)) return `#${raw}`
      return undefined
    }

    /**
     * Render 0..1 coverage as the two hex digits xterm's parser expects.
     * @param alpha - coverage; clamped, and `undefined` means fully opaque.
     * @returns two lowercase hex digits.
     */
    function toAlphaByte(alpha) {
      const value = typeof alpha === 'number' && Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1
      return Math.round(value * 255).toString(16).padStart(2, '0')
    }

    /**
     * Build the decoration options the search addon needs for a highlight.
     *
     * Two tints of one accent: every match gets the faint one so the scrollback
     * still reads as text, and the selected match gets a stronger one so the jump
     * is obvious. Both are derived from a theme colour, which is why this reads one
     * at all — the addon cannot take a `var(...)` string, and the colour has to be
     * resolved to a literal before it will paint anything.
     *
     * The overview-ruler entries are required by the API even though this panel
     * never enables the ruler; they are the same accent.
     * @param accent - the theme's highlight hue, as hex.
     * @returns the decoration options, or undefined when the accent is unusable.
     */
    function searchDecorations(accent) {
      const match = withAlpha(accent, 0.18)
      const active = withAlpha(accent, 0.45)
      if (match === undefined || active === undefined) return undefined
      return {
        matchBackground: match,
        activeMatchBackground: active,
        activeMatchBorder: withAlpha(accent, 1),
        matchOverviewRuler: withAlpha(accent, 1),
        activeMatchColorOverviewRuler: withAlpha(accent, 1),
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
     * What one host's tab says.
     *
     * The configured alias wins, and that is the whole point: it is the name the
     * user chose to recognise the machine by, and the one `~/.ssh/config` calls it.
     * The remote's own hostname is only a fallback for a target that has no alias,
     * because preferring it means a tab reads `user-H3C-UniServer-R5300-G6` while
     * the entry the user created is called `A100` — the tab stops being an answer
     * to "which machine is this".
     * @param session - one entry from the connected `sessions` list.
     * @returns the text to render in the tab.
     */
    function tabLabel(session) {
      const server = session.server ?? {}
      return server.label ?? session.hostname ?? server.host ?? session.serverId
    }

    /**
     * The address a server connects to, as `user@host:port`.
     * @param server - a public server record.
     * @returns the endpoint; the user part is left out when there is none.
     */
    function endpointOf(server) {
      const user = typeof server.user === 'string' && server.user.length > 0 ? `${server.user}@` : ''
      return `${user}${server.host}:${server.port}`
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
    /**
     * Count a query in the scrollback and locate the selected match among them.
     *
     * The addon reports a count too, through `onDidChangeResults`, but that figure
     * is the length of its *decoration* list: it stops collecting at its highlight
     * limit (1000 by default) and reports `-1` for the index once the selected
     * match falls outside that slice. A number that silently stops at 1000, or
     * reads 3/1000 when it is really 3/4821, is worse than no number. This walks
     * the buffer the user is actually looking at and counts every occurrence.
     *
     * Rows are re-joined by `isWrapped` first: a long line is stored as several
     * rows, and a match may well straddle the wrap, so counting per row would miss
     * it and misreport the total.
     * @param buffer - `term.buffer.active`.
     * @param query - the search term.
     * @param selection - `term.getSelectionPosition()`, whose rows are absolute.
     * @returns the total count and the 1-based index of the selected match, or 0.
     */
    function scanMatches(buffer, query, selection) {
      const needle = query.toLowerCase()
      if (needle.length === 0) return { total: 0, index: 0 }
      const selRow = selection === undefined || selection === null ? -1 : selection.start.y
      const selCol = selection === undefined || selection === null ? -1 : selection.start.x
      let total = 0
      let index = 0
      // The logical line being assembled, with each contributing row's offset into
      // it, so a selection can be mapped back to an offset in the joined text.
      let text = ''
      let offsets = []
      let rowNumbers = []
      const countLine = () => {
        const haystack = text.toLowerCase()
        let from = 0
        for (;;) {
          const at = haystack.indexOf(needle, from)
          if (at < 0) break
          total += 1
          if (index === 0 && selRow >= 0) {
            const position = rowNumbers.indexOf(selRow)
            if (position >= 0) {
              const selected = offsets[position] + selCol
              // The selection is exactly the match, so its start is the match start.
              if (at === selected) index = total
            }
          }
          from = at + needle.length
        }
      }
      for (let row = 0; row < buffer.length; row += 1) {
        const line = buffer.getLine(row)
        if (line === undefined) continue
        const chunk = line.translateToString(true)
        if (line.isWrapped && rowNumbers.length > 0) {
          offsets.push(text.length)
          rowNumbers.push(row)
          text += chunk
          continue
        }
        countLine()
        text = chunk
        offsets = [0]
        rowNumbers = [row]
      }
      countLine()
      return { total, index }
    }

    function TerminalPane({ serverId, termId, t, visible, focused }) {
      const holderRef = React.useRef(null)
      const termRef = React.useRef(null)
      const fitRef = React.useRef(null)
      const searchRef = React.useRef(null)
      const searchInputRef = React.useRef(null)
      /** Set by `open()`: searches the live emulator. Stable across renders. */
      const searchJumpRef = React.useRef(undefined)
      const cursorRef = React.useRef(0)
      const pendingRef = React.useRef('')
      const flushRef = React.useRef(undefined)
      const [phase, setPhase] = React.useState('closed')
      const [failure, setFailure] = React.useState('')
      const [size, setSize] = React.useState(null)
      const [exitCode, setExitCode] = React.useState(undefined)
      /** Whether the scrollback search bar is open over this pane. */
      const [searchOpen, setSearchOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      /** `{ total, index }` counted from the buffer, or null before a search. */
      const [results, setResults] = React.useState(null)
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
          // Search runs over the scrollback this pane already holds, so it needs no
          // Host round trip at all. Highlighting every match is opt-in through
          // `decorations`, and that option only accepts literal `#RRGGBB[AA]`
          // colours — a token or `color-mix()` is rejected by the addon's own
          // parser and nothing is painted. `searchDecorations` therefore reads one
          // colour out of the theme and derives the two tints from it.
          const search = new vendored.SearchAddon()
          term.loadAddon(search)
          searchRef.current = search
          // Deliberately NOT `--dsw-alias-brand-primary`: that token is a neutral
          // (`neutral-bluish-1000` in light, `-50` in dark), so washing it over the
          // screen raises or lowers the contrast of the very glyphs being searched
          // for. A near-white wash on a dark terminal is the worst case, because
          // the text there is light too — the match becomes unreadable exactly
          // where it is supposed to stand out. `state-warn-primary` is the only hue
          // the theme exposes that reads on both backgrounds, and amber is what
          // find-in-page highlighting uses anyway.
          const decorations = searchDecorations(readThemeColor('--dsw-alias-state-warn-primary'))

          /**
           * Jump to the next match, forward or backward.
           * @param direction - `'next'` or `'previous'`.
           * @param term_ - the search term.
           */
          const jump = (direction, term_) => {
            const node = termRef.current
            if (term_.length === 0) {
              searchRef.current.clearDecorations()
              node?.clearSelection()
              setResults(null)
              return
            }
            const options = { caseSensitive: false, incremental: true }
            // Without this the selected match is only shown by the selection tint,
            // which reads as "nothing happened" while typing: the count updates but
            // the scrollback does not.
            if (decorations !== undefined) options.decorations = decorations
            const found = direction === 'next'
              ? searchRef.current.findNext(term_, options)
              : searchRef.current.findPrevious(term_, options)
            if (!found) {
              setResults({ total: 0, index: 0 })
              return
            }
            if (node !== null) {
              setResults(scanMatches(node.buffer.active, term_, node.getSelectionPosition()))
            }
          }
          searchJumpRef.current = jump

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

      // Ctrl+F opens search over the scrollback.
      //
      // The listener sits on the shell rather than on the emulator, because xterm
      // forwards key events to the remote shell: without capturing here, Ctrl+F
      // would be sent as a byte to whatever is running, and in `less` or `vim` it
      // is a real paging key. Ctrl+F is taken only when a terminal is on screen;
      // nothing else in this panel uses it.
      React.useEffect(() => {
        if (!visible) return undefined
        const node = holderRef.current
        if (node === null) return undefined
        const onKeyDown = (event) => {
          if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'f' || event.key === 'F')) {
            event.preventDefault()
            event.stopPropagation()
            setSearchOpen(true)
            return
          }
          // Escape closes the bar from anywhere in the pane.
          if (event.key === 'Escape' && searchOpen) {
            event.preventDefault()
            event.stopPropagation()
            setSearchOpen(false)
            setQuery('')
            setResults(null)
            searchRef.current?.clearDecorations()
            termRef.current?.focus()
          }
        }
        node.addEventListener('keydown', onKeyDown, true)
        return () => node.removeEventListener('keydown', onKeyDown, true)
      }, [visible, searchOpen])

      // Focus the field the moment the bar appears, so Ctrl+F then typing works.
      React.useEffect(() => {
        if (!searchOpen) return
        const field = searchInputRef.current
        if (field === null) return
        field.focus()
        field.select()
      }, [searchOpen])

      /**
       * Closing the bar must give the keyboard back to the terminal.
       *
       * Leaving focus in a hidden input would swallow every keystroke, which in a
       * terminal is worse than a missing feature: the shell would look dead.
       */
      const closeSearch = React.useCallback(() => {
        setSearchOpen(false)
        setQuery('')
        setResults(null)
        // `clearDecorations` only drops the addon's own state; the last match stays
        // selected on screen unless the selection is cleared too.
        searchRef.current?.clearDecorations()
        termRef.current?.clearSelection()
        termRef.current?.focus()
      }, [])

      /**
       * Run the search for a typed value.
       * @param value - the new query.
       */
      const runSearch = React.useCallback((value) => {
        setQuery(value)
        if (value.length === 0) {
          searchRef.current?.clearDecorations()
          termRef.current?.clearSelection()
          setResults(null)
          return
        }
        searchJumpRef.current?.('next', value)
      }, [])

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
          searchOpen
            ? h('div', { className: 'ssc-search', role: 'search' },
              h('input', {
                ref: searchInputRef,
                className: 'ssc-search-input',
                type: 'text',
                value: query,
                placeholder: t('terminal.searchPlaceholder'),
                'aria-label': t('terminal.search'),
                spellCheck: false,
                onChange: (event) => runSearch(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    searchJumpRef.current?.(event.shiftKey ? 'previous' : 'next', query)
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    closeSearch()
                    return
                  }
                  // Ctrl+F again while already in the field must not fall through to
                  // the browser's own find dialog.
                  if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'f' || event.key === 'F')) {
                    event.preventDefault()
                    event.stopPropagation()
                    event.currentTarget.select()
                  }
                },
              }),
              h('span', { className: 'ssc-search-count' },
                results === null
                  ? ''
                  : results.total === 0
                    ? t('terminal.searchNone')
                    : results.index === 0
                      // The total is exact even when the selected match could not be
                      // located, which happens when it starts above the oldest row
                      // still in the scrollback.
                      ? t('terminal.searchCountOf', { count: results.total })
                      : t('terminal.searchCount', { index: results.index, count: results.total })),
              h('button', {
                type: 'button',
                className: 'ssc-search-step',
                title: t('terminal.searchPrev'),
                'aria-label': t('terminal.searchPrev'),
                disabled: query.length === 0,
                onClick: () => searchJumpRef.current?.('previous', query),
              }, '↑'),
              h('button', {
                type: 'button',
                className: 'ssc-search-step',
                title: t('terminal.searchNext'),
                'aria-label': t('terminal.searchNext'),
                disabled: query.length === 0,
                onClick: () => searchJumpRef.current?.('next', query),
              }, '↓'),
              h('button', {
                type: 'button',
                className: 'ssc-search-close',
                title: t('terminal.searchClose'),
                'aria-label': t('terminal.searchClose'),
                onClick: closeSearch,
              }, '×'))
            : null,
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

      // A closed terminal must not leave its slot empty.
      React.useEffect(() => {
        const repaired = repairPanes(termIds, panes)
        if (repaired !== null) setPanes(repaired)
      }, [termIds, panes])

      // Derived at render time as well, so a close never shows a blank frame
      // while the repair effect above catches up.
      const shown = shownPanes(termIds, panes)
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
      /**
       * The close handler, read through a ref rather than captured by the effect.
       *
       * Every call site passes `onClose` as an inline arrow, so its identity is new
       * on each render. An effect that depended on it re-ran on every render — and
       * this panel re-renders every couple of seconds while the overview polls. Each
       * re-run blurred whatever the user was in and re-focused the first field,
       * which closed the server `<select>` mid-pick and looked like the refresh was
       * interrupting the form.
       */
      const closeRef = React.useRef(onClose)
      React.useEffect(() => {
        closeRef.current = onClose
      })

      // Mount-only on purpose: taking and restoring focus is a property of the
      // dialog being open, not of any prop. Re-running it is the bug above.
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            closeRef.current()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        const previous = document.activeElement
        const panel = panelRef.current
        // Prefer a field over the header's close button. `querySelector` answers in
        // document order, and the close button comes first, so a single grouped
        // selector would put the caret on "close" every time this dialog opens --
        // the opposite of what a keyboard user expects to type into.
        const field = panel?.querySelector('select, input, textarea')
        const focusable = field ?? panel?.querySelector('button')
        ;(focusable ?? panel)?.focus()
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [])

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
    function Connector({
      catalogue, selectedId, password, busy, draft, editing, failure,
      onSelect, onDraft, onPassword, onConnect, onSave, onRemove, onNew, onCancelNew,
      lead = true, t,
    }) {
      const server = catalogue?.servers.find((entry) => entry.id === selectedId)
      // A target declared in this plugin's own config has no file to write back to,
      // so the fields are read-only for it rather than silently discarded.
      const canEdit = catalogue?.canEdit !== false && (editing === null || server?.editable === true)
      const configPath = catalogue?.configPath ?? '~/.ssh/config'
      /**
       * One text field of the form.
       * @param key - the draft key it edits.
       * @param label - the visible label.
       * @param extra - optional input attributes.
       * @returns the field.
       */
      const field = (key, label, extra) => h('label', { className: 'ssc-field ssc-field-inline' },
        h('span', { className: 'ssc-field-label' }, label),
        h('input', Object.assign({
          className: 'ssc-control',
          type: 'text',
          value: draft[key] ?? '',
          disabled: busy || !canEdit,
          autoComplete: 'off',
          spellCheck: false,
          onChange: (event) => onDraft(key, event.target.value),
        }, extra ?? {})))
      return h('div', { className: 'ssc-connect' },
        lead
          ? h('div', { className: 'ssc-connect-lead' },
            h('h3', { className: 'ssc-connect-title' }, t('connect.title')),
            h('p', { className: 'ssc-connect-sub' }, t('connect.subtitle')))
          : null,
        // Two modes share one form, and which one is showing is decided by whether a
        // server is selected, so the picker and the fields can never disagree.
        //
        // The mode switch sits in the SAME slot in both modes: "new" while looking
        // at a server, "cancel" while drafting one. Same place, opposite meaning, so
        // the row never reflows and the button reads as belonging to the picker
        // above it rather than to the save/delete actions at the bottom. An earlier
        // version put a "new server (unsaved)" entry INSIDE the dropdown, which
        // looked like a target one could connect to, and it survived closing the
        // dialog because the mode was tracked in state separate from the selection.
        h('div', { className: 'ssc-picker-head' },
          h('span', {
            className: editing === null ? 'ssc-new-badge' : 'ssc-field-label',
          }, editing === null ? t('server.newTitle') : t('connect.server')),
          canEdit && (editing !== null || (catalogue?.servers.length ?? 0) > 0)
            ? h('button', {
              type: 'button',
              className: 'ssc-btn ssc-btn-quiet',
              onClick: editing === null ? onCancelNew : onNew,
              disabled: busy,
              title: editing === null ? t('server.cancelHint') : t('server.newHint'),
            }, editing === null ? t('server.cancel') : `+ ${t('server.new')}`)
            : null),
        editing === null
          ? h('span', { className: 'ssc-new-sub' }, t('server.newSub'))
          : h('select', {
            className: 'ssc-control',
            value: selectedId,
            disabled: busy,
            onChange: (event) => onSelect(event.target.value),
          },
          catalogue === null || catalogue.servers.length === 0
            ? h('option', { value: '' }, t('connect.serverNone'))
            : catalogue.servers.map((entry) => h('option', { key: entry.id, value: entry.id },
              `${entry.label} — ${entry.user === undefined || entry.user === '' ? entry.host : `${entry.user}@${entry.host}`}:${entry.port}`))),
        // The fields always show the selected target and are edited in place; a new
        // target simply starts blank. That is the whole mode model, so there is no
        // separate "create" screen to get lost in.
        h('div', { className: 'ssc-field-row' },
          field('label', t('server.label'), { placeholder: t('server.labelPlaceholder') }),
          field('port', t('server.port'), { className: 'ssc-control ssc-control-narrow', inputMode: 'numeric' })),
        h('div', { className: 'ssc-field-row' },
          field('host', t('server.host'), { placeholder: t('server.hostPlaceholder') }),
          field('user', t('server.user'), { className: 'ssc-control ssc-control-narrow' })),
        field('identityFile', t('server.identityFile'), { placeholder: t('server.identityFilePlaceholder') }),
        server === undefined
          ? null
          : h('span', { className: 'ssc-field-hint' }, `${server.host}:${server.port} · ${
            server.editable === true ? t('server.fromConfig', { file: configPath }) : t('server.fromPlugin')
          }`),
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
        failure.length > 0 ? h('div', { className: 'ssc-hint ssc-fail', role: 'alert' }, failure) : null,
        // Actions stay about the form's contents: connect, or keep. Starting another
        // belongs with the picker up top, and removal is separated at the far end
        // because it is the only one that destroys something.
        h('div', { className: 'ssc-actions' },
          h('button', {
            type: 'button',
            className: 'ssc-btn ssc-btn-primary',
            onClick: onConnect,
            disabled: busy
              || draft.host.trim().length === 0
              // Connecting saves first, and a new target needs an alias before it
              // can be written, so the button stays off until the form is complete.
              || (canEdit && editing === null && draft.label.trim().length === 0),
          }, busy ? t('connect.connecting') : t('connect.action')),
          canEdit
            ? h('button', {
              type: 'button',
              className: 'ssc-btn',
              onClick: onSave,
              disabled: busy || draft.label.trim().length === 0 || draft.host.trim().length === 0,
              title: t('server.saveHint'),
            }, t('server.save'))
            : null,
          canEdit && editing !== null
            ? h('button', {
              type: 'button',
              className: 'ssc-btn ssc-btn-danger ssc-actions-end',
              onClick: onRemove,
              disabled: busy,
              title: t('server.removeHint'),
            }, t('server.remove'))
            : null))
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
      /**
       * The editable copy of the selected target.
       *
       * Which target is being edited is NOT stored separately: it is whatever
       * `selectedId` points at, and `editing` below is derived from the catalogue.
       * An earlier version kept the alias in its own state alongside `selectedId`,
       * and the two could drift — clicking "new" cleared the alias but left the id,
       * so the form was blank while the picker still named a server.
       */
      const [draft, setDraft] = React.useState(EMPTY_DRAFT)
      const [formFailure, setFormFailure] = React.useState('')
      // Which server the current new-mode session was started from, so "cancel"
      // can hand the user back to what they were looking at.
      const startedFromRef = React.useRef('')
      // Start from whatever was last sampled rather than from nothing: reopening
      // the panel should show the last numbers and refresh them, not blank out.
      const [snapshots, setSnapshots] = React.useState(() => Object.fromEntries(SNAPSHOT_CACHE))
      // Servers whose displayed numbers came from the cache and have not been
      // re-read yet during this mount.
      const [unrefreshed, setUnrefreshed] = React.useState(() => new Set(SNAPSHOT_CACHE.keys()))
      const [tab, setTab] = React.useState('overview')
      const [busy, setBusy] = React.useState(false)
      const [connectorOpen, setConnectorOpen] = React.useState(false)
      // A host key that is not on file yet, waiting for the user to compare it.
      const [trustPrompt, setTrustPrompt] = React.useState(null)
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

      /**
       * The entry being edited, or undefined when a new target is being typed.
       *
       * Derived, never stored. This is the single source of truth for the mode, so
       * the picker and the fields cannot disagree about which target is on screen.
       */
      const editingEntry = catalogue === null
        ? undefined
        : catalogue.servers.find((candidate) => candidate.id === selectedId)
      const editing = editingEntry === undefined ? null : editingEntry.label

      /**
       * Load the selected target into the form.
       *
       * This is what makes selection and editing the same act: picking a server
       * fills the fields with its values, so there is no "edit" button to find. A
       * selection that no longer exists (after a delete) clears the form to the new
       * state instead of leaving stale values behind.
       */
      React.useEffect(() => {
        if (catalogue === null) return
        const entry = catalogue.servers.find((candidate) => candidate.id === selectedId)
        setDraft(entry === undefined ? EMPTY_DRAFT : draftFrom(entry))
        setFormFailure('')
      }, [catalogue, selectedId])

      React.useEffect(() => {
        if (pollId.length === 0) return undefined
        let alive = true
        const tick = async () => {
          let next
          try {
            next = await call('metrics', { serverId: pollId })
          } catch (error) {
            next = { error: error instanceof Error ? error.message : String(error) }
          }
          if (!alive) return
          // Cache outside the state updater: an updater must stay pure, and
          // React may run it twice to check that.
          SNAPSHOT_CACHE.set(pollId, next)
          setSnapshots((current) => ({ ...current, [pollId]: next }))
          setUnrefreshed((current) => {
            if (!current.has(pollId)) return current
            const copy = new Set(current)
            copy.delete(pollId)
            return copy
          })
        }
        void tick()
        const timer = setInterval(() => void tick(), catalogue?.refreshMs ?? 2000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [pollId, catalogue?.refreshMs])

      /**
       * Connect to the selected target, after agreeing on its host key.
       *
       * The key is inspected first, in a handshake that carries no credentials, so
       * the fingerprint can be compared before anything secret is offered. A key
       * that disagrees with `known_hosts` is a hard stop: that is what an
       * interception looks like, and it must not be reachable through the
       * "first visit" path.
       * @param approved - a fingerprint the user has already confirmed.
       */
      /**
       * Write the form into `~/.ssh/config`.
       * @param mode - `'add'` or `'update'`.
       * @param forConnect - whether this save is a step of connecting.
       * @returns the saved id, or undefined when the save was refused.
       */
      const saveForm = React.useCallback(async (mode, forConnect = false) => {
        setFormFailure('')
        const request = {
          mode,
          label: draft.label,
          host: draft.host,
          port: draft.port,
          user: draft.user,
          identityFile: draft.identityFile,
        }
        if (mode === 'update' && editing !== null) request.originalLabel = editing
        try {
          const saved = await call('saveServer', request)
          setCatalogue(saved)
          // Selecting the saved target is what leaves new mode: `editing` follows
          // the selection, so there is no second piece of state to update here.
          setSelectedId(saved.savedId)
          return saved.savedId
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // While connecting the message belongs next to the connect button, since
          // that is the action the user just took.
          if (forConnect) setFailure(message)
          else setFormFailure(message)
          return undefined
        }
      }, [draft, editing])

      /**
       * Save the form, then connect.
       *
       * Saving first is deliberate: the credentials are about to be offered to
       * whatever the fields say, and a connection that is not written down would
       * leave the list describing a different machine than the one now open.
       * @param approved - a host-key fingerprint the user has already confirmed.
       */
      const connect = React.useCallback(async (approved) => {
        if (draft.host.trim().length === 0) return
        setBusy(true)
        setFailure('')
        try {
          // Each connect starts from what the form now says, because the previous
          // attempt may have created an entry that the next step must reuse.
          let targetId = selectedId
          const editable = catalogue?.canEdit !== false
          const entry = catalogue?.servers.find((candidate) => candidate.id === selectedId)
          const needsSave = editable && (editing === null ? true : entry?.editable === true)
          if (needsSave) {
            const nextMode = editing === null ? 'add' : 'update'
            targetId = await saveForm(nextMode, true)
            if (targetId === undefined) return
          }
          // If the key cannot be inspected, the connection must not proceed: the
          // whole point is that no credential is offered to an unidentified host.
          // This also covers an older Host half answering, which reports the method
          // as unknown rather than anything a user could act on.
          let key
          try {
            key = await call('hostKey', { serverId: targetId })
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            // A transport failure is not a trust decision. Reporting a refused
            // connection as "the key could not be verified" sends the reader off to
            // inspect known_hosts when the real problem is that nothing answers.
            setFailure(error?.code === 'ssh/unreachable'
              ? t('trust.unreachable', { reason })
              : t('trust.unavailable', { reason }))
            return
          }
          if (key.status === 'mismatch' || key.status === 'revoked') {
            setTrustPrompt(null)
            setFailure(key.status === 'revoked'
              ? t('trust.revoked', { host: key.host, file: key.knownHostsPath })
              : t('trust.mismatch', { host: key.host, file: key.knownHostsPath }))
            return
          }
          if (key.status === 'unknown' && approved !== key.fingerprint) {
            // Stop before the password is offered and ask.
            setTrustPrompt(key)
            return
          }
          const request = { serverId: targetId }
          if (password.length > 0) request.password = password
          if (key.status === 'unknown') request.trustFingerprint = key.fingerprint
          await call('connect', request)
          setTrustPrompt(null)
          setPassword('')
          setConnectorOpen(false)
          await refreshSessions()
          setActiveId(targetId)
          remember(targetId)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [catalogue, draft.host, editing, password, refreshSessions, remember, saveForm, selectedId, t])

      /** Save without connecting. */
      const saveOnly = React.useCallback(async () => {
        setBusy(true)
        try {
          await saveForm(editing === null ? 'add' : 'update')
        } finally {
          setBusy(false)
        }
      }, [editing, saveForm])

      /** Ask before removing, then remove the selected target's block. */
      const removeSelected = React.useCallback(async () => {
        if (editing === null) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          const question = t('server.removeConfirm', { label: editing })
          if (!window.confirm(question)) return
        }
        setBusy(true)
        setFormFailure('')
        try {
          const next = await call('removeServer', { label: editing })
          setCatalogue(next)
          // Moving the selection is what leaves edit mode for good, and the form
          // follows it: the deleted target's values cannot linger.
          setSelectedId(next.servers[0]?.id ?? '')
          await refreshSessions()
        } catch (error) {
          setFormFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [editing, refreshSessions, t])

      /**
       * Start a new target: clear the selection, which is what defines new mode.
       *
       * Clearing `selectedId` is the whole change. Leaving it set was the bug: the
       * form emptied but the picker still named a server, and reopening the dialog
       * brought that contradiction back.
       */
      const startNew = React.useCallback(() => {
        startedFromRef.current = selectedId
        setSelectedId('')
        setDraft(EMPTY_DRAFT)
        setFormFailure('')
      }, [selectedId])

      /** Leave new mode and go back to whichever target was on screen before. */
      const cancelNew = React.useCallback(() => {
        const back = startedFromRef.current
        const exists = catalogue !== null && catalogue.servers.some((entry) => entry.id === back)
        setSelectedId(exists ? back : (catalogue?.servers[0]?.id ?? ''))
        setFormFailure('')
      }, [catalogue])

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
        draft,
        editing,
        failure: formFailure.length > 0 ? formFailure : failure,
        onSelect: remember,
        onDraft: (key, value) => setDraft((current) => ({ ...current, [key]: value })),
        onPassword: setPassword,
        onConnect: () => void connect(undefined),
        onSave: () => void saveOnly(),
        onRemove: () => void removeSelected(),
        onNew: startNew,
        onCancelNew: cancelNew,
        lead: !connected,
        t,
      })
      const connectorDialog = connected && connectorOpen
        ? h(Modal, { title: t('connect.title'), onClose: () => setConnectorOpen(false) }, connector)
        : null

      // Shown instead of connecting, so the comparison happens before any
      // credential leaves the machine.
      const trustDialog = trustPrompt === null
        ? null
        : h(Modal, { title: t('trust.title'), onClose: () => setTrustPrompt(null) },
          h('div', { className: 'ssc-trust' },
            h('p', { className: 'ssc-trust-lead' },
              t('trust.lead', { host: trustPrompt.host, port: trustPrompt.port })),
            h('dl', { className: 'ssc-trust-list' },
              h('dt', null, t('trust.keyType')),
              h('dd', { className: 'ssc-mono' }, trustPrompt.keyType),
              h('dt', null, t('trust.fingerprint')),
              h('dd', { className: 'ssc-mono ssc-trust-fp' }, trustPrompt.fingerprint),
              h('dt', null, t('trust.file')),
              h('dd', { className: 'ssc-mono' }, trustPrompt.knownHostsPath)),
            h('p', { className: 'ssc-trust-hint' }, t('trust.hint')),
            h('div', { className: 'ssc-trust-actions' },
              h('button', {
                type: 'button',
                className: 'ssc-btn',
                onClick: () => setTrustPrompt(null),
                disabled: busy,
              }, t('trust.cancel')),
              h('button', {
                type: 'button',
                className: 'ssc-btn ssc-btn-primary',
                onClick: () => void connect(trustPrompt.fingerprint),
                disabled: busy,
              }, busy ? t('connect.connecting') : t('trust.accept')))))

      const strip = connected
        ? h('div', { className: 'ssc-strip' },
          h('div', { className: 'ssc-chips' },
            sessions.map((session) => {
              const server = session.server ?? {}
              // The tab carries the name the user gave the machine; the address and
              // the remote's own hostname live in the tooltip, one hover away.
              const endpoint = endpointOf(server)
              const hostname = session.hostname
              const title = typeof hostname === 'string' && hostname.length > 0
                ? `${endpoint} · ${hostname}`
                : endpoint
              return h('span', {
                key: session.serverId,
                className: `ssc-chip ${session.serverId === activeId ? 'ssc-chip-on' : ''}`,
                role: 'button',
                tabIndex: 0,
                title,
                onClick: () => setActiveId(session.serverId),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveId(session.serverId)
                  }
                },
              },
              h('span', { className: 'ssc-dot' }),
              h('span', { className: 'ssc-chip-name' }, tabLabel(session)),
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
        trustDialog,
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
                  ? h(OverviewTab, { key: `overview:${activeId}`, session: active, snapshot: snapshots[activeId] ?? null, stale: unrefreshed.has(activeId), t })
                  : tab === 'processes'
                    ? h(ProcessesTab, { key: `processes:${activeId}`, session: active, snapshot: snapshots[activeId] ?? null, stale: unrefreshed.has(activeId), t })
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
          descriptorFor('hostKey'),
          descriptorFor('saveServer'),
          descriptorFor('removeServer'),
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
