declare global {
  namespace App {
    interface Locals {
      workspaceId: string;
    }
    interface PageData {
      title?: string;
    }
  }
}

export {};
