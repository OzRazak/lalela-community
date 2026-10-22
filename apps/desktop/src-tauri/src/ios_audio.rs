//! iOS-only: shared AVAudioSession control. cpal's iOS (CoreAudio) backend
//! never configures the session, and without category `.record` + activation
//! the microphone stream opens fine but delivers pure silence.

use objc2_avf_audio::{AVAudioSession, AVAudioSessionCategoryRecord};

/// Put the shared audio session into record mode and activate it. Must run
/// before the cpal input stream is built. The first activation triggers the
/// system mic-permission prompt (backed by NSMicrophoneUsageDescription).
pub fn activate() -> Result<(), String> {
    unsafe {
        let session = AVAudioSession::sharedInstance();
        // The category constant is a weak-linked static, hence the Option.
        let record = AVAudioSessionCategoryRecord
            .ok_or_else(|| "AVAudioSessionCategoryRecord unavailable".to_string())?;
        session
            .setCategory_error(record)
            .map_err(|e| format!("audio session category failed: {e:?}"))?;
        session
            .setActive_error(true)
            .map_err(|e| format!("audio session activation failed: {e:?}"))?;
    }
    Ok(())
}

/// Release the session after recording so other apps' audio can resume.
/// Best-effort: a failure here only delays the hand-back, so it is ignored.
pub fn deactivate() {
    unsafe {
        let _ = AVAudioSession::sharedInstance().setActive_error(false);
    }
}
