// Integration: trainer-website-shape via runtime-ts.
// Reuses SP2's 9-entity fixture for cross-package consistency.
// Runs against InMemoryDriver (fast) — DB integration via driver-parity test.

import { describe, test, expect, beforeEach } from "bun:test";
import { Loader } from "@metaobjects/metadata";
import { resolve } from "node:path";
import { ObjectManager } from "../src/index.js";
import { inMemoryDriver } from "../src/drivers/index.js";
import type { Row } from "../src/persistence-driver.js";

const FIXTURE = resolve(import.meta.dir, "../../codegen-ts/test/fixtures/trainer-website-shape.json");

let om: ObjectManager;

beforeEach(async () => {
  const loader = new Loader();
  const result = await loader.load([FIXTURE]);
  expect(result.errors).toEqual([]);
  const driver = inMemoryDriver({
    pkFields: {
      subscribers: ["id"], programs: ["id"], weeks: ["id"], workouts: ["id"],
      exercises: ["id"], videos: ["id"], workout_events: ["id"], purchases: ["id"], tags: ["id"],
    },
  });
  om = new ObjectManager({ metadata: result.root, driver });
});

describe("Integration — trainer-website-shape via runtime-ts", () => {
  test("9 entities load and start empty", async () => {
    expect(await om.count("Subscriber")).toBe(0);
    expect(await om.count("Program")).toBe(0);
    expect(await om.count("Tag")).toBe(0);
  });

  test("end-to-end CRUD on Subscriber", async () => {
    const sub = await om.create("Subscriber", {
      email: "user@example.com",
      firstName: "User",
      subscribed: true,
      createdAt: "2026-05-10T00:00:00Z",
    });
    expect(typeof sub.id).toBe("number");

    const refreshed = await om.findById("Subscriber", sub.id);
    expect(refreshed?.email).toBe("user@example.com");

    await om.update("Subscriber", sub.id, { firstName: "Updated" });
    expect((await om.findById("Subscriber", sub.id))?.firstName).toBe("Updated");

    expect(await om.delete("Subscriber", sub.id)).toBe(true);
    expect(await om.count("Subscriber")).toBe(0);
  });

  test("relationship: Workout includes Week (1:1)", async () => {
    const program = await om.create("Program", {
      slug: "p1", title: "P1", priceCents: 100, isPublished: true, createdAt: "2026-05-10T00:00:00Z",
    });
    const week = await om.create("Week", { programId: program.id, weekNumber: 1, title: "W1" });
    const workout = await om.create("Workout", { weekId: week.id, orderIndex: 1, title: "WO" });

    const got = await om.findById("Workout", workout.id, { include: ["week"] });
    expect((got!.week as Row).weekNumber).toBe(1);
  });

  test("validation rejects missing required fields", async () => {
    await expect(om.create("Subscriber", {})).rejects.toMatchObject({
      name: "ValidationError",
      errors: expect.arrayContaining([expect.objectContaining({ rule: "required" })]),
    });
  });

  test("ref-string round-trip", async () => {
    const program = await om.create("Program", {
      slug: "p2", title: "P2", priceCents: 200, isPublished: false, createdAt: "2026-05-10T00:00:00Z",
    });
    const ref = om.refOf("Program", program);
    expect(ref).toBe(`Program:${program.id}`);
    const loaded = await om.load(ref);
    expect(loaded?.title).toBe("P2");
  });
});
