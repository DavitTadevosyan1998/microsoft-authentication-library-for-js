import { ClientAuthError } from "../error/ClientAuthError";
import { UrlUtils } from "./UrlUtils";
import { StringUtils } from "./StringUtils";
import { Logger } from "../Logger";
import { AuthError } from "./../error/AuthError";
import { MessageCache } from "../messaging/MessageCache";
import { MessageHelper } from "../messaging/MessageHelper";

export class WindowUtils {
    /**
     * @hidden
     * Interval in milliseconds that we poll a window
     * @ignore
     */
    private static POLLING_INTERVAL_MS = 50;

    /**
     * @hidden
     * Checks if the current page is running in an iframe.
     * @ignore
     */
    static isInIframe(): boolean {
        return window.parent !== window;
    }

    /**
     * @hidden
     * Checks if the current page is running in an iframe.
     * @ignore
     */
    static isWindowOnTop(): boolean {
        return window.top === window;
    }

    /**
     * @hidden
     * Check if the current page is running in a popup.
     * @ignore
     */
    static isInPopup(): boolean {
        return !!(window.opener && window.opener !== window);
    }

    /**
     * @hidden
     * Monitors a window until it loads a url with a hash
     * @ignore
     */
    static monitorWindowForHash(contentWindow: Window, timeout: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const maxTicks = timeout / WindowUtils.POLLING_INTERVAL_MS;
            let ticks = 0;

            const intervalId = setInterval(() => {
                if (contentWindow.closed) {
                    clearInterval(intervalId);
                    resolve();
                }

                let href;
                try {
                    /*
                     * Will throw if cross origin,
                     * which should be caught and ignored
                     * since we need the interval to keep running while on STS UI.
                     */
                    href = contentWindow.location.href;
                } catch (e) {}

                // Don't process blank pages or cross domain
                if (!href || href === "about:blank") {
                    return;
                }

                // Only run clock when we are on same domain
                ticks++;

                if (UrlUtils.urlContainsHash(href)) {
                    clearInterval(intervalId);
                    resolve(contentWindow.location.hash);
                } else if (ticks > maxTicks) {
                    clearInterval(intervalId);
                    reject(ClientAuthError.createTokenRenewalTimeoutError()); // better error?
                }
            }, WindowUtils.POLLING_INTERVAL_MS);
        });
    }

    /**
     * @hidden
     * Loads iframe with authorization endpoint URL
     * @ignore
     */
    static loadFrame(urlNavigate: string, frameName: string, timeoutMs: number, logger: Logger): Promise<HTMLIFrameElement> {
        /*
         * This trick overcomes iframe navigation in IE
         * IE does not load the page consistently in iframe
         */
        logger.info("LoadFrame: " + frameName);

        return new Promise((resolve, reject) => {
            setTimeout(() => {
                const frameHandle = WindowUtils.addHiddenIFrame(frameName, logger);

                if (!frameHandle) {
                    reject(`Unable to load iframe with name: ${frameName}`);
                    return;
                }

                if (frameHandle.src === "" || frameHandle.src === "about:blank") {
                    frameHandle.src = urlNavigate;
                    logger.infoPii("Frame Name : " + frameName + " Navigated to: " + urlNavigate);
                }

                resolve(frameHandle);
            }, timeoutMs);
        });
    }

    /**
     * @hidden
     * Adds the hidden iframe for silent token renewal.
     * @ignore
     */
    static addHiddenIFrame(iframeId: string, logger: Logger): HTMLIFrameElement {
        if (typeof iframeId === "undefined") {
            return null;
        }

        logger.info("Add msal frame to document:" + iframeId);
        let adalFrame = document.getElementById(iframeId) as HTMLIFrameElement;
        if (!adalFrame) {
            if (document.createElement &&
        document.documentElement &&
        (window.navigator.userAgent.indexOf("MSIE 5.0") === -1)) {
                const ifr = document.createElement("iframe");
                ifr.setAttribute("id", iframeId);
                ifr.style.visibility = "hidden";
                ifr.style.position = "absolute";
                ifr.style.width = ifr.style.height = "0";
                ifr.style.border = "0";
                ifr.setAttribute("sandbox", "allow-same-origin");
                adalFrame = (document.getElementsByTagName("body")[0].appendChild(ifr) as HTMLIFrameElement);
            } else if (document.body && document.body.insertAdjacentHTML) {
                document.body.insertAdjacentHTML("beforeend", "<iframe name='" + iframeId + "' id='" + iframeId + "' style='display:none'></iframe>");
            }

            if (window.frames && window.frames[iframeId]) {
                adalFrame = window.frames[iframeId];
            }
        }

        return adalFrame;
    }

    /**
     * @hidden
     * Find and return the iframe element with the given hash
     * @ignore
     */
    static getIframeWithHash(hash: string) {
        return Array.from(document.getElementsByTagName("iframe")).find(iframe => {
            try {
                return iframe.contentWindow.location.hash === hash;
            } catch (e) {
                return false;
            }
        });
    }

    /**
     * @hidden
     * Returns an array of all the popups opened by MSAL
     * @ignore
     */
    static getPopups(): Array<Window> {
        if (!window.openedWindows) {
            window.openedWindows = [];
        }

        return window.openedWindows;
    }

    /**
     * @hidden
     * Find and return the popup with the given hash
     * @ignore
     */
    static getPopUpWithHash(hash: string): Window {
        return WindowUtils.getPopups().find(popup => {
            try {
                return popup.location.hash === hash;
            } catch (e) {
                return false;
            }
        });
    }

    /**
     * @hidden
     * Add the popup to the known list of popups
     * @ignore
     */
    static trackPopup(popup: Window): void {
        WindowUtils.getPopups().push(popup);
    }

    /**
     * @hidden
     * Close all popups
     * @ignore
     */
    static closePopups(): void {
        WindowUtils.getPopups().forEach(popup => popup.close());
    }

    /**
     * @hidden
     * Used to redirect the browser to the STS authorization endpoint
     * @param {string} urlNavigate - URL of the authorization endpoint
     */
    static navigateWindow(urlNavigate: string, logger: Logger, popupWindow?: Window) {
        // Navigate if valid URL
        if (!StringUtils.isEmpty(urlNavigate)) {
            const navigateWindow: Window = popupWindow ? popupWindow : window;
            const logMessage: string = popupWindow ? "Navigated Popup window to:" + urlNavigate : "Navigate to:" + urlNavigate;
            logger.infoPii(logMessage);
            navigateWindow.location.replace(urlNavigate);
        }
        else {
            logger.info("Navigate url is empty");
            throw AuthError.createUnexpectedError("Navigate url is empty");
        }
    }

    /**
     * IFRAMEDAPPS: if we are redirecting in an iframe, post a message to the topFrame; else navigate to the popup Window
     * @param popUpWindow
     * @param urlNavigate
     * @param messageCache
     * @param logger
     * @param topFrameOrigin
     */
    static navigateHelper(popUpWindow: Window, urlNavigate: string, messageCache: MessageCache, logger: Logger, topFrameOrigin?: string) {
        // IFRAMEDAPPS: if we are redirecting in an iframe, post a message to the topFrame
        if(WindowUtils.isInIframe() && !popUpWindow) {
            MessageHelper.redirectDelegationRequest(messageCache, urlNavigate, topFrameOrigin);
        }
        // prompt user for interaction
        else {
            WindowUtils.navigateWindow(urlNavigate, logger, popUpWindow);
        }
    }

}
