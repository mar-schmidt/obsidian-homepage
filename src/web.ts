import { ItemView, Platform, ViewStateResult } from "obsidian";
import { tr } from "./locale";

export const WEB_VIEW_TYPE = "homepage-web";
const FALLBACK_PARTITION = "persist:homepage-web";

/** The parts of Electron's <webview> element that the view uses. */
interface WebviewElement extends HTMLElement {
	src: string;
	partition: string;
	allowpopups: boolean;
	reload(): void;
	executeJavaScript(code: string): Promise<unknown>;
}

type WebviewEvent = Event & {
	title?: string;
	url?: string;
	errorCode?: number;
	errorDescription?: string;
	isMainFrame?: boolean;
};

type ElectronRenderer = { ipcRenderer?: { send(channel: string, ...args: unknown[]): void } };

/**
 * Runs inside a claude.ai page and hides what claude.ai draws above an artifact (the bar with the chat
 * and share buttons), so the artifact fills the tab. It only hides elements that sit wholly above the
 * largest frame on the page, and never dialogs or anything that asks for permission.
 */
const HIDE_CLAUDE_HEADER = `(() => {
	if (window.__nvHomepageHeader) return;
	window.__nvHomepageHeader = true;
	const MARK = "data-nv-homepage-hidden";
	const style = document.createElement("style");
	style.textContent = "[" + MARK + "] { display: none !important; }";
	(document.head || document.documentElement).appendChild(style);
	const KEEP = /allow|approve|permission|review|deny|connect|access|sign in|tillåt|godkänn|behörighet|neka|anslut|åtkomst|logga in/i;
	const area = el => { const r = el.getBoundingClientRect(); return r.width * r.height; };
	const tidy = () => {
		const frames = Array.from(document.querySelectorAll("iframe")).filter(f => area(f) > 60000);
		if (!frames.length) return;
		const frame = frames.reduce((a, b) => (area(b) > area(a) ? b : a));
		const top = frame.getBoundingClientRect().top;
		if (top < 4) return;
		for (let node = frame; node && node !== document.body; node = node.parentElement) {
			for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
				if (sib.hasAttribute(MARK) || /^(STYLE|SCRIPT|LINK|META)$/.test(sib.tagName)) continue;
				if (sib.matches("[role=dialog], [role=alertdialog], [aria-modal=true]") || KEEP.test(sib.textContent || "")) continue;
				const r = sib.getBoundingClientRect();
				if (r.height > 0 && r.height < 160 && r.bottom <= top + 2) sib.setAttribute(MARK, "");
			}
		}
	};
	let timer = null;
	const schedule = () => {
		if (timer) return;
		timer = setTimeout(() => { timer = null; tidy(); }, 60);
	};
	new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
	window.addEventListener("resize", schedule);
	tidy();
})();`;

function isClaudePage(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host === "claude.ai" || host.endsWith(".claude.ai");
	}
	catch {
		return false;
	}
}

export function normalizeUrl(value: string): string | null {
	const raw = (value || "").trim();
	if (!raw) return null;

	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
	}
	catch {
		return null;
	}
}

function getElectron(): ElectronRenderer | undefined {
	const req = (window as unknown as { require?: (id: string) => unknown }).require;
	try {
		return req?.("electron") as ElectronRenderer | undefined;
	}
	catch {
		return undefined;
	}
}

export class HomepageWebView extends ItemView {
	url: string = "";
	title: string = "";
	currentUrl: string = "";
	hideHeader: boolean = true;
	webview: WebviewElement | null = null;

	getViewType(): string {
		return WEB_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.title || tr("webPageTitle");
	}

	getIcon(): string {
		return "house";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("nv-web-view");
		this.addAction("external-link", tr("webOpenExternally"), () => this.openExternally());
		this.addAction("rotate-cw", tr("webReload"), () => this.reload());
		this.render();
	}

	async onClose(): Promise<void> {
		this.webview?.remove();
		this.webview = null;
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), url: this.url, hideHeader: this.hideHeader };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const { url, hideHeader } = (state ?? {}) as { url?: unknown, hideHeader?: unknown };

		if (typeof hideHeader === "boolean") this.hideHeader = hideHeader;
		if (typeof url === "string" && url !== this.url) {
			this.url = url;
			this.render();
		}

		await super.setState(state, result);
	}

	reload(): void {
		if (this.webview?.isConnected) this.webview.reload();
		else this.render();
	}

	openExternally(): void {
		const target = this.currentUrl || normalizeUrl(this.url);
		//"_external" makes Obsidian hand the link to the system browser instead of its web viewer
		if (target) window.open(target, "_external");
	}

	render(): void {
		this.webview?.remove();
		this.webview = null;
		this.contentEl.empty();

		const url = normalizeUrl(this.url);
		if (!url) {
			if (this.url) this.showMessage(tr("webPageInvalid", this.url));
			return;
		}
		if (!Platform.isDesktopApp) {
			this.showMessage(tr("webPageDesktopOnly"));
			return;
		}

		//Share the vault's browser session with Obsidian's own web viewer, so a sign-in survives restarts.
		//Obsidian prepares that session as it does for its web viewer, which includes a user agent
		//without the Electron token that sign-in pages such as Google's refuse.
		const partition = this.app.getWebviewPartition?.() ?? FALLBACK_PARTITION;
		getElectron()?.ipcRenderer?.send("create-browser-session", partition, null);

		const webview = this.contentEl.ownerDocument.createElement("webview") as WebviewElement;
		webview.addClass("nv-web-frame");
		webview.partition = partition;
		webview.allowpopups = true;

		webview.addEventListener("page-title-updated", (e: WebviewEvent) => {
			this.title = e.title || "";
			this.leaf.updateHeader?.();
		});
		webview.addEventListener("did-navigate", (e: WebviewEvent) => this.currentUrl = e.url || this.currentUrl);
		webview.addEventListener("did-navigate-in-page", (e: WebviewEvent) => this.currentUrl = e.url || this.currentUrl);
		webview.addEventListener("did-start-loading", () => {
			this.contentEl.addClass("is-loading");
			this.contentEl.querySelector(".nv-web-message")?.remove();
		});
		webview.addEventListener("did-stop-loading", () => this.contentEl.removeClass("is-loading"));
		webview.addEventListener("dom-ready", () => {
			if (this.hideHeader && isClaudePage(this.currentUrl || url)) {
				webview.executeJavaScript(HIDE_CLAUDE_HEADER).catch(() => {});
			}
		});
		webview.addEventListener("did-fail-load", (e: WebviewEvent) => {
			//-3 is an aborted load, which redirects cause all the time
			if (!e.isMainFrame || e.errorCode === -3) return;
			this.showMessage(tr("webLoadFailed", e.errorDescription || String(e.errorCode)), true);
		});

		webview.setAttribute("src", url);
		this.contentEl.appendChild(webview);
		this.webview = webview;
	}

	showMessage(text: string, retry: boolean = false): void {
		this.contentEl.querySelector(".nv-web-message")?.remove();

		const box = this.contentEl.createDiv({ cls: "nv-web-message" });
		box.createEl("p", { text });

		if (retry) {
			box.createEl("button", { text: tr("webRetry"), cls: "mod-cta" })
				.addEventListener("click", () => {
					box.remove();
					this.reload();
				});
		}
	}
}
