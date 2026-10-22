#include "bindings/bindings.h"

// Defined in Swift (WatchConnectivityReceiver.swift, @_cdecl). Brings the
// WatchConnectivity receiver online so recordings sent from the paired Apple
// Watch are stashed into watch-inbox/ for the Rust scan to import. Declared here
// (rather than pulled from a generated -Swift.h header) to keep this file's
// dependencies identical to the pre-watch build.
extern "C" void lalela_watch_receiver_start(void);

int main(int argc, char * argv[]) {
	lalela_watch_receiver_start();
	ffi::start_app();
	return 0;
}
