/**
 * 드래그 MIME 3종 구분 (멀티프로젝트 P6). 프로젝트 탭·세션행·dockview 내부
 * 드래그가 서로 무간섭이려면 전용 MIME이 겹치지 않아야 한다 — 화면 드롭존은
 * 프로젝트 MIME에만, dock 세션 드롭은 세션 MIME에만 반응한다.
 */
import { describe, expect, it, vi } from "vitest";

// ProjectTabs는 store(→@tauri-apps/api)·plugin-dialog를 transitively import 하지만
// 이 테스트가 읽는 건 모듈 상수 하나뿐 — 안전하게 no-op 목킹.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: vi.fn(() => Promise.resolve(() => {})) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));

import { PROJECT_DRAG_MIME } from "./ProjectTabs";
import { SESSION_DRAG_MIME } from "./sessionDropZone";

describe("드래그 MIME 3종 구분", () => {
  it("프로젝트·세션 MIME은 서로 다른 전용 타입", () => {
    expect(PROJECT_DRAG_MIME).toBe("application/x-workbench-project");
    expect(SESSION_DRAG_MIME).toBe("application/x-workbench-session");
    expect(PROJECT_DRAG_MIME).not.toBe(SESSION_DRAG_MIME);
  });

  it("둘 다 x-workbench 네임스페이스지만 접미사가 갈린다(dockview 내부 MIME과도 무충돌)", () => {
    expect(PROJECT_DRAG_MIME.startsWith("application/x-workbench-")).toBe(true);
    expect(SESSION_DRAG_MIME.startsWith("application/x-workbench-")).toBe(true);
    // dockview 내부 드래그는 자체 MIME(우리 것 아님) — 우리 두 타입과 겹치지 않는다.
    expect(PROJECT_DRAG_MIME).not.toContain("session");
    expect(SESSION_DRAG_MIME).not.toContain("project");
  });
});
