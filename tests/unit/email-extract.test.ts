import { describe, it, expect } from "vitest";
import {
  deobfuscate,
  isNoiseEmail,
  isRoleEmail,
  prioritizeEmails,
  extractEmails,
  extractMailtoEmails,
} from "../../src/tools/enrich/email-extract.js";

describe("deobfuscate", () => {
  it("handles HTML entity &#64; → @", () => {
    expect(deobfuscate("foo&#64;bar.at")).toBe("foo@bar.at");
  });
  it("handles HTML entity &#x40; (hex) → @", () => {
    expect(deobfuscate("foo&#x40;bar.at")).toBe("foo@bar.at");
  });
  it("handles [at] bracket form", () => {
    expect(deobfuscate("max [at] example.at")).toBe("max@example.at");
  });
  it("handles (at) paren form", () => {
    expect(deobfuscate("office (at) kanzlei.at")).toBe("office@kanzlei.at");
  });
  it("handles German (ät)", () => {
    expect(deobfuscate("mail (ät) firma.at")).toBe("mail@firma.at");
  });
  it("handles [æt]", () => {
    expect(deobfuscate("info [æt] example.at")).toBe("info@example.at");
  });
  it("chains at + dot deobfuscation in one pass", () => {
    expect(deobfuscate("a [at] b [dot] c")).toBe("a@b.c");
  });
  it("preserves normal emails untouched", () => {
    expect(deobfuscate("hello@world.com")).toBe("hello@world.com");
  });
});

describe("isNoiseEmail", () => {
  it("strips example.com/org/net", () => {
    expect(isNoiseEmail("foo@example.com")).toBe(true);
    expect(isNoiseEmail("bar@example.org")).toBe(true);
    expect(isNoiseEmail("baz@example.net")).toBe(true);
  });
  it("strips domain.tld / test.com", () => {
    expect(isNoiseEmail("x@domain.tld")).toBe(true);
    expect(isNoiseEmail("x@test.com")).toBe(true);
  });
  it("strips noreply / no-reply", () => {
    expect(isNoiseEmail("noreply@anywhere.at")).toBe(true);
    expect(isNoiseEmail("no-reply@anywhere.at")).toBe(true);
    expect(isNoiseEmail("do-not-reply@anywhere.at")).toBe(true);
  });
  it("strips webmaster / postmaster / abuse", () => {
    expect(isNoiseEmail("webmaster@hoster.com")).toBe(true);
    expect(isNoiseEmail("postmaster@hoster.com")).toBe(true);
    expect(isNoiseEmail("abuse@hoster.com")).toBe(true);
  });
  it("strips admin@wordpress.org", () => {
    expect(isNoiseEmail("admin@wordpress.org")).toBe(true);
  });
  // spec §C I3: role-based emails are NOT noise
  it("keeps info@ / office@ / kontakt@ (legitimate B2B)", () => {
    expect(isNoiseEmail("info@juwelier-beispiel.at")).toBe(false);
    expect(isNoiseEmail("office@kanzlei.at")).toBe(false);
    expect(isNoiseEmail("kontakt@handwerker.at")).toBe(false);
    expect(isNoiseEmail("contact@firm.com")).toBe(false);
    expect(isNoiseEmail("hello@firm.com")).toBe(false);
    expect(isNoiseEmail("buero@firma.at")).toBe(false);
    expect(isNoiseEmail("sales@firma.at")).toBe(false);
  });
  it("keeps personal emails", () => {
    expect(isNoiseEmail("max.mustermann@firma.at")).toBe(false);
    expect(isNoiseEmail("j.doe@firma.at")).toBe(false);
  });
});

describe("isRoleEmail", () => {
  it("classifies role-based local parts", () => {
    expect(isRoleEmail("info@x.at")).toBe(true);
    expect(isRoleEmail("office@x.at")).toBe(true);
    expect(isRoleEmail("kontakt@x.at")).toBe(true);
    expect(isRoleEmail("info.wien@x.at")).toBe(true);
    expect(isRoleEmail("info42@x.at")).toBe(true);
  });
  it("classifies personalised addresses as non-role", () => {
    expect(isRoleEmail("max.mustermann@x.at")).toBe(false);
    expect(isRoleEmail("j.doe@x.at")).toBe(false);
  });
});

describe("prioritizeEmails", () => {
  it("puts personal addresses before role addresses", () => {
    const out = prioritizeEmails([
      "info@x.at",
      "max.mustermann@x.at",
      "office@x.at",
      "anna.huber@x.at",
    ]);
    expect(out[0]).toMatch(/mustermann|huber/);
    expect(out[1]).toMatch(/mustermann|huber/);
    expect(out.slice(2)).toContain("info@x.at");
    expect(out.slice(2)).toContain("office@x.at");
  });
});

describe("extractEmails", () => {
  it("extracts plain emails from text", () => {
    const out = extractEmails("Kontakt: office@firma.at oder info@firma.at");
    expect(out).toContain("office@firma.at");
    expect(out).toContain("info@firma.at");
  });
  it("deobfuscates before extracting", () => {
    const out = extractEmails("mail: foo [at] bar [dot] at");
    expect(out).toContain("foo@bar.at");
  });
  it("filters noise mails", () => {
    const out = extractEmails(
      "real@firma.at noreply@service.com webmaster@h.de",
    );
    expect(out).toContain("real@firma.at");
    expect(out).not.toContain("noreply@service.com");
    expect(out).not.toContain("webmaster@h.de");
  });
  it("keeps role-based B2B emails", () => {
    const out = extractEmails("info@juwelier.at office@kanzlei.at");
    expect(out).toContain("info@juwelier.at");
    expect(out).toContain("office@kanzlei.at");
  });
  it("prioritises personal over role", () => {
    const out = extractEmails(
      "info@firma.at and max.mustermann@firma.at",
    );
    expect(out[0]).toBe("max.mustermann@firma.at");
  });
});

describe("extractMailtoEmails", () => {
  it("strips mailto: prefix and query", () => {
    const out = extractMailtoEmails([
      "mailto:hello@firma.at",
      "mailto:office@firma.at?subject=Anfrage",
    ]);
    expect(out).toEqual(["hello@firma.at", "office@firma.at"]);
  });
  it("ignores non-mailto hrefs", () => {
    const out = extractMailtoEmails(["tel:+4318700000"]);
    expect(out).toEqual([]);
  });
});
