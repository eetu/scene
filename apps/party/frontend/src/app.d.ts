// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/** js-dos v8, loaded on demand from /vendor/js-dos/js-dos.js (self-hosted).
	 *  Returns a command interface with a `stop()` for teardown. */
	/** The running emulator, handed over via the `ci-ready` event. */
	interface DosCommandInterface {
		simulateKeyPress: (...keyCodes: number[]) => void;
		sendKeyEvent: (keyCode: number, pressed: boolean) => void;
		exit?: () => void;
	}
	interface DosOptions {
		url: string;
		pathPrefix?: string;
		autoStart?: boolean;
		kiosk?: boolean;
		theme?: string;
		onEvent?: (event: string, ci?: DosCommandInterface) => void;
	}
	/** What `Dos()` returns — the UI handle, with teardown. */
	interface DosProps {
		stop?: () => void;
	}
	interface Window {
		Dos?: (element: HTMLElement, options: DosOptions) => DosProps;
	}
}

export {};
