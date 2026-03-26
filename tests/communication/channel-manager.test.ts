import { describe, it, expect, beforeEach } from "vitest";
import { ChannelManager } from "../../src/communication/channel-manager.js";

describe("ChannelManager", () => {
  let mgr: ChannelManager;
  beforeEach(() => { mgr = new ChannelManager(); });

  describe("createChannel", () => {
    it("creates channel with owner as first subscriber", () => {
      const ch = mgr.createChannel("inbox-cto", "CTO Inbox", "CTO messages", "cto");
      expect(ch.channelId).toBe("inbox-cto");
      expect(ch.subscribers).toContain("cto");
      expect(ch.messageCount).toBe(0);
    });
    it("throws on duplicate channelId", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      expect(() => mgr.createChannel("ch", "Ch2", "", "ceo")).toThrow(/already exists/);
    });
  });

  describe("subscribe / unsubscribe", () => {
    it("adds subscriber", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      mgr.subscribe("ch", "architect");
      expect(mgr.getChannel("ch")!.subscribers).toContain("architect");
    });
    it("subscribe is idempotent", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      mgr.subscribe("ch", "architect");
      mgr.subscribe("ch", "architect");
      expect(mgr.getChannel("ch")!.subscribers.filter((s) => s === "architect")).toHaveLength(1);
    });
    it("unsubscribe removes agent", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      mgr.subscribe("ch", "architect");
      mgr.unsubscribe("ch", "architect");
      expect(mgr.getChannel("ch")!.subscribers).not.toContain("architect");
    });
  });

  describe("post", () => {
    it("posts and returns message", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      const msg = mgr.post("ch", "architect", "Sprint update", "All tasks complete");
      expect(msg.subject).toBe("Sprint update");
      expect(msg.consumed).toBe(false);
      expect(mgr.getChannel("ch")!.messageCount).toBe(1);
    });
    it("notifies listeners", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      const received: string[] = [];
      mgr.onNewMessage("ch", (m) => received.push(m.subject));
      mgr.post("ch", "a", "Hello", "world");
      expect(received).toEqual(["Hello"]);
    });
    it("unsubscribing listener stops notifications", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      const received: string[] = [];
      const unsub = mgr.onNewMessage("ch", (m) => received.push(m.subject));
      unsub();
      mgr.post("ch", "a", "Hello", "world");
      expect(received).toHaveLength(0);
    });
  });

  describe("read / readUnconsumed", () => {
    it("read returns all messages", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      mgr.post("ch", "a", "S1", "B1");
      mgr.post("ch", "a", "S2", "B2");
      expect(mgr.read("ch")).toHaveLength(2);
    });
    it("readUnconsumed returns only unconsumed", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      const m1 = mgr.post("ch", "a", "S1", "B1");
      mgr.post("ch", "a", "S2", "B2");
      mgr.consume("ch", m1.messageId, "cto");
      expect(mgr.readUnconsumed("ch")).toHaveLength(1);
    });
  });

  describe("consume", () => {
    it("marks message as consumed", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      const m = mgr.post("ch", "a", "S", "B");
      mgr.consume("ch", m.messageId, "cto");
      expect(mgr.readUnconsumed("ch")).toHaveLength(0);
      expect(mgr.getChannel("ch")!.unconsumedCount).toBe(0);
    });
    it("consume is idempotent", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      const m = mgr.post("ch", "a", "S", "B");
      mgr.consume("ch", m.messageId, "cto");
      expect(() => mgr.consume("ch", m.messageId, "cto")).not.toThrow();
    });
    it("throws for unknown message", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      expect(() => mgr.consume("ch", "nope", "cto")).toThrow(/not found/);
    });
  });

  describe("consumeAll", () => {
    it("drains all unconsumed messages", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      mgr.post("ch", "a", "S1", "B1");
      mgr.post("ch", "a", "S2", "B2");
      const consumed = mgr.consumeAll("ch", "cto");
      expect(consumed).toHaveLength(2);
      expect(mgr.readUnconsumed("ch")).toHaveLength(0);
    });
  });

  describe("deleteChannel", () => {
    it("removes the channel", () => {
      mgr.createChannel("ch", "Ch", "", "cto");
      mgr.deleteChannel("ch");
      expect(mgr.getChannel("ch")).toBeNull();
    });
    it("throws for unknown channel", () => {
      expect(() => mgr.deleteChannel("ghost")).toThrow(/not found/);
    });
  });
});
