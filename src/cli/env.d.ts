export {};

declare global {
	namespace NodeJS {
		interface ProcessEnv {
			DEBUG?: string;
		}
	}
}
