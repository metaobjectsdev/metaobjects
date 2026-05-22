import { describe, test, expect } from "bun:test";
import {
  FIELD_ATTR_AUTO_SET,
  AUTO_SET_ON_CREATE,
  AUTO_SET_ON_UPDATE,
  AUTO_SET_VALUES,
} from "../src/index.js";

describe("@autoSet constants", () => {
  test("FIELD_ATTR_AUTO_SET is 'autoSet'", () => {
    expect(FIELD_ATTR_AUTO_SET).toBe("autoSet");
  });
  test("AUTO_SET_ON_CREATE is 'onCreate'", () => {
    expect(AUTO_SET_ON_CREATE).toBe("onCreate");
  });
  test("AUTO_SET_ON_UPDATE is 'onUpdate'", () => {
    expect(AUTO_SET_ON_UPDATE).toBe("onUpdate");
  });
  test("AUTO_SET_VALUES contains both", () => {
    expect(AUTO_SET_VALUES).toEqual(["onCreate", "onUpdate"]);
  });
});
