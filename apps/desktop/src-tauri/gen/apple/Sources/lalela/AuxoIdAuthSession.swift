// "Continue with Auxo ID" on iPhone/iPad — the in-app browser sheet.
//
// The Mac app hands the sign-in back through a 127.0.0.1 loopback listener; on
// iOS that isn't reliable (the app is suspended while Safari is in front). So
// the iOS app runs the same web flow inside an ASWebAuthenticationSession and
// asks it to watch for the callback scheme `lalela`: when the web app's confirm
// step redirects to lalela://auxo-id?code=…&state=… (or ?error=…), the session
// intercepts that navigation, closes the sheet and hands the URL to us. No URL
// scheme is registered in Info.plist — the session delivers the callback only
// to the app that started it, so no other app can claim it and nothing else
// can open Lalela with it.
//
// Hand-rolled C ABI (same pattern as AppleAIBridge.swift); the Rust half is
// src-tauri/src/auxo_id_ios.rs:
//
//   lalela_auxo_id_auth_start(url, scheme, ctx, done)
//       Starts the session on the main queue. `done(ctx, callbackUrl, error)`
//       is called EXACTLY ONCE: callbackUrl non-NULL on success, else error is
//       one of "cancelled" | "busy" | "no_window" | "start_failed" | "bad_url"
//       | "failed: <description>". Strings are only valid during the call.
//   lalela_auxo_id_auth_cancel()
//       Dismisses a live sheet; its pending `done` fires with "cancelled".

import AuthenticationServices
import Foundation
import UIKit

public typealias LalelaAuxoIdDone = @convention(c) (UInt64, UnsafePointer<CChar>?, UnsafePointer<CChar>?) -> Void

@_cdecl("lalela_auxo_id_auth_start")
public func lalelaAuxoIdAuthStart(
    _ url: UnsafePointer<CChar>,
    _ scheme: UnsafePointer<CChar>,
    _ ctx: UInt64,
    _ done: LalelaAuxoIdDone
) {
    // Copy the C strings before hopping queues — they're only valid for this call.
    let urlString = String(cString: url)
    let schemeString = String(cString: scheme)
    DispatchQueue.main.async {
        AuxoIdAuthSession.shared.start(urlString, scheme: schemeString, ctx: ctx, done: done)
    }
}

@_cdecl("lalela_auxo_id_auth_cancel")
public func lalelaAuxoIdAuthCancel() {
    DispatchQueue.main.async {
        AuxoIdAuthSession.shared.cancel()
    }
}

/// Main-queue only. Holds the one live session (it must be retained while it
/// runs) and guarantees its `done` callback fires exactly once.
final class AuxoIdAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuxoIdAuthSession()

    private var session: ASWebAuthenticationSession?
    private var pending: (ctx: UInt64, done: LalelaAuxoIdDone)?

    func start(_ urlString: String, scheme: String, ctx: UInt64, done: @escaping LalelaAuxoIdDone) {
        if pending != nil {
            Self.call(done, ctx, url: nil, error: "busy")
            return
        }
        guard let url = URL(string: urlString), url.scheme == "https" || url.scheme == "http" else {
            Self.call(done, ctx, url: nil, error: "bad_url")
            return
        }
        guard keyWindow() != nil else {
            Self.call(done, ctx, url: nil, error: "no_window")
            return
        }
        pending = (ctx, done)
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callbackURL, error in
            // The completion handler may arrive on any queue.
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let callbackURL = callbackURL {
                    self.finish(url: callbackURL.absoluteString, error: nil)
                } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    self.finish(url: nil, error: "cancelled")
                } else {
                    self.finish(url: nil, error: "failed: \(error?.localizedDescription ?? "unknown")")
                }
            }
        }
        s.presentationContextProvider = self
        // Share Safari's cookies so an existing Auxo ID sign-in is reused (iOS
        // shows its standard "Lalela wants to use … to sign in" prompt first).
        s.prefersEphemeralWebBrowserSession = false
        session = s
        if !s.start() {
            finish(url: nil, error: "start_failed")
        }
    }

    func cancel() {
        guard pending != nil else { return }
        session?.cancel()
        finish(url: nil, error: "cancelled")
    }

    private func finish(url: String?, error: String?) {
        guard let p = pending else { return } // already reported
        pending = nil
        session = nil
        Self.call(p.done, p.ctx, url: url, error: error)
    }

    private static func call(_ done: LalelaAuxoIdDone, _ ctx: UInt64, url: String?, error: String?) {
        if let url = url {
            url.withCString { done(ctx, $0, nil) }
        } else {
            (error ?? "failed").withCString { done(ctx, nil, $0) }
        }
    }

    private func keyWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first { $0.isKeyWindow } ?? windows.first
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return keyWindow() ?? ASPresentationAnchor()
    }
}
