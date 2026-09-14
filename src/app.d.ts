declare global {
	namespace App {
		interface Locals {
			session: { subject: string; name: string } | null;
		}
		interface PageData {
			session: { subject: string; name: string } | null;
		}
	}
}
export {};
