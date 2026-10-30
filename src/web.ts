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
}

type WebviewEvent = Event & {
	title?: string;
	url?: string;
	errorCode?: number;
	errorDescription?: string;
	isMainFrame?: boolean;
};

type ElectronRenderer = { ipcRenderer?: { send(channel: string, ...args: unknown[]): void } };

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
		return { ...super.getState(), url: this.url };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const url = (state as { url?: unknown } | null)?.url;

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
