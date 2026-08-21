jest.mock("../../src/lib/redis", () => ({
  redisUsersSessions: {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    sAdd: jest.fn(),
    sRem: jest.fn(),
    sMembers: jest.fn(),
    expire: jest.fn(),
  },
}));

import { redisUsersSessions } from "../../src/lib/redis";
import { createUserSession, getUserSession, deleteUserSession, deleteAllUserSessions, listUserSessions } from "../../src/lib/session";

const mockedRedis = redisUsersSessions as jest.Mocked<typeof redisUsersSessions>;

describe("session.ts (multi-device sessions)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("createUserSession stores the session under a userId+sessionId key, not userId alone", async () => {
    await createUserSession("user-1", "session-A", { ip: "1.2.3.4" });

    expect(mockedRedis.set).toHaveBeenCalledWith(
      "session:user:user-1:session-A",
      expect.any(String),
      expect.objectContaining({ EX: expect.any(Number) })
    );
    // Also indexed, so it can be listed/revoked alongside other sessions
    // for the same user.
    expect(mockedRedis.sAdd).toHaveBeenCalledWith("session:user:user-1:index", "session-A");
  });

  it("getUserSession looks up the exact session, not any session belonging to the user", async () => {
    mockedRedis.get.mockResolvedValue(JSON.stringify({ ip: "1.2.3.4" }));
    await getUserSession("user-1", "session-A");
    expect(mockedRedis.get).toHaveBeenCalledWith("session:user:user-1:session-A");
  });

  it("deleteUserSession removes only the specified session, leaving others for the same user untouched", async () => {
    await deleteUserSession("user-1", "session-A");
    expect(mockedRedis.del).toHaveBeenCalledWith("session:user:user-1:session-A");
    expect(mockedRedis.sRem).toHaveBeenCalledWith("session:user:user-1:index", "session-A");
    // Never touches a "session-B" key that might belong to the same user's other device.
    expect(mockedRedis.del).not.toHaveBeenCalledWith("session:user:user-1:session-B");
  });

  it("deleteAllUserSessions removes every session found in the index", async () => {
    mockedRedis.sMembers.mockResolvedValue(["session-A", "session-B", "session-C"]);
    await deleteAllUserSessions("user-1");

    expect(mockedRedis.del).toHaveBeenCalledWith("session:user:user-1:session-A");
    expect(mockedRedis.del).toHaveBeenCalledWith("session:user:user-1:session-B");
    expect(mockedRedis.del).toHaveBeenCalledWith("session:user:user-1:session-C");
    expect(mockedRedis.del).toHaveBeenCalledWith("session:user:user-1:index");
  });

  it("listUserSessions returns metadata for every still-live session and prunes expired ones from the index", async () => {
    mockedRedis.sMembers.mockResolvedValue(["session-A", "session-B"]);
    mockedRedis.get.mockImplementation((key: string) => {
      if (key.endsWith("session-A")) return Promise.resolve(JSON.stringify({ ip: "1.1.1.1" }));
      return Promise.resolve(null); // session-B's TTL already expired
    });

    const sessions = await listUserSessions("user-1");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("session-A");
    // The expired one should be pruned from the index rather than left dangling.
    expect(mockedRedis.sRem).toHaveBeenCalledWith("session:user:user-1:index", "session-B");
  });
});
