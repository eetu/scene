
/* ======================================================================== *
 *  scene sample-data shim
 *  Appended to libopenmpt/libopenmpt_c.cpp by compile.sh (where the
 *  `openmpt_module` struct → module_impl is visible).
 *
 *  libopenmpt's public API exposes sample NAMES only; the raw PCM + loop points
 *  live in the internal CSoundFile. These three stateless helpers read them off
 *  an existing module handle (reached via module_impl::shim_get_sndfile(), the
 *  one accessor added by patch.py). That's all the custom build needs — jamming
 *  plays this PCM directly through Web Audio, no playback engine involved.
 * ======================================================================== */
#include "common/stdafx.h" /* OpenMPT base types (int32 etc.) — the soundlib preamble */
#include "soundlib/Sndfile.h"

extern "C" {

static OPENMPT_NAMESPACE::CSoundFile * sf_of( openmpt_module * mod ) {
	return ( mod && mod->impl ) ? mod->impl->shim_get_sndfile() : 0;
}

int smp_count( openmpt_module * mod ) {
	OPENMPT_NAMESPACE::CSoundFile * sf = sf_of( mod );
	return sf ? (int) sf->GetNumSamples() : 0;
}

/* Fill out[0..15] (caller allocates 16 ints):
 *   [0] len              [1] loopStart      [2] loopEnd
 *   [3] sustainStart     [4] sustainEnd     [5] rate (middle-C Hz)
 *   [6] channels         [7] bits           [8] flags
 *        (bit0 loop | bit1 pingpong | bit2 sustain | bit3 sustain-pingpong)
 *   [9] volume 0..256    [10] panning 0..256 (-1 if no pan flag set)
 *   [11] finetune        [12] relative note  [13] global volume 0..64
 * Sample index is 1-based (libopenmpt convention). Returns 1 on success. */
int smp_info( openmpt_module * mod, int index, int * out ) {
	OPENMPT_NAMESPACE::CSoundFile * sf = sf_of( mod );
	if ( !sf || index < 1 || index > (int) sf->GetNumSamples() ) return 0;
	const OPENMPT_NAMESPACE::ModSample & s = sf->GetSample( (OPENMPT_NAMESPACE::SAMPLEINDEX) index );
	out[0] = (int) s.nLength;
	out[1] = (int) s.nLoopStart;
	out[2] = (int) s.nLoopEnd;
	out[3] = (int) s.nSustainStart;
	out[4] = (int) s.nSustainEnd;
	out[5] = (int) s.GetSampleRate( sf->GetType() );
	out[6] = s.GetNumChannels();
	out[7] = s.GetElementarySampleSize() * 8;
	out[8] = ( s.HasLoop() ? 1 : 0 ) | ( s.HasPingPongLoop() ? 2 : 0 ) | ( s.HasSustainLoop() ? 4 : 0 ) |
	         ( s.HasPingPongSustainLoop() ? 8 : 0 );
	out[9] = (int) s.nVolume;
	out[10] = s.uFlags[OPENMPT_NAMESPACE::CHN_PANNING] ? (int) s.nPan : -1;
	out[11] = (int) s.nFineTune;
	out[12] = (int) s.RelativeTone;
	out[13] = (int) s.nGlobalVol;
	out[14] = 0;
	out[15] = 0;
	return 1;
}

/* Copy the sample's RAW data verbatim (native bit-depth, interleaved for stereo)
 * to `out` — for a bit-exact WAV export with no resampling/requantization.
 * `out` must hold nLength * (bits/8) * channels bytes. Returns bytes written. */
int smp_raw( openmpt_module * mod, int index, unsigned char * out, int maxBytes ) {
	OPENMPT_NAMESPACE::CSoundFile * sf = sf_of( mod );
	if ( !sf || index < 1 || index > (int) sf->GetNumSamples() ) return 0;
	const OPENMPT_NAMESPACE::ModSample & s = sf->GetSample( (OPENMPT_NAMESPACE::SAMPLEINDEX) index );
	if ( !s.HasSampleData() ) return 0;
	int bytes = (int) ( s.nLength * s.GetBytesPerSample() );
	if ( bytes > maxBytes ) bytes = maxBytes;
	const unsigned char * src = (const unsigned char *) s.samplev();
	for ( int i = 0; i < bytes; ++i ) out[i] = src[i];
	return bytes;
}

/* Write up to maxFrames mono float samples ([-1,1], channel 0) to out.
 * Returns the number of frames written. */
int smp_read( openmpt_module * mod, int index, float * out, int maxFrames ) {
	OPENMPT_NAMESPACE::CSoundFile * sf = sf_of( mod );
	if ( !sf || index < 1 || index > (int) sf->GetNumSamples() ) return 0;
	const OPENMPT_NAMESPACE::ModSample & s = sf->GetSample( (OPENMPT_NAMESPACE::SAMPLEINDEX) index );
	if ( !s.HasSampleData() ) return 0;
	int frames = (int) s.nLength;
	if ( frames > maxFrames ) frames = maxFrames;
	const int ch = s.GetNumChannels();
	if ( s.GetElementarySampleSize() == 2 ) {
		const OPENMPT_NAMESPACE::int16 * p = s.sample16();
		for ( int i = 0; i < frames; ++i ) out[i] = p[ (size_t) i * ch ] * ( 1.0f / 32768.0f );
	} else {
		const OPENMPT_NAMESPACE::int8 * p = s.sample8();
		for ( int i = 0; i < frames; ++i ) out[i] = p[ (size_t) i * ch ] * ( 1.0f / 128.0f );
	}
	return frames;
}

/* Mute/unmute pattern channel `ch` (0-based) on the LIVE module, so the song's
 * own render drops/keeps that channel — for editor solo/mute. Mirrors
 * libopenmpt_ext's module_ext_impl::set_channel_mute_status: set CHN_MUTE|
 * CHN_SYNCMUTE on the channel's settings + play-state, and on any NNA/virtual
 * channels mastered to it. Reached via the same CSoundFile accessor as smp_*;
 * no ext module needed. Returns 1 on success. */
int chan_mute( openmpt_module * mod, int ch, int on ) {
	OPENMPT_NAMESPACE::CSoundFile * sf = sf_of( mod );
	if ( !sf || ch < 0 || ch >= (int) sf->GetNumChannels() ) return 0;
	const bool mute = on ? true : false;
	const auto flags = OPENMPT_NAMESPACE::CHN_MUTE | OPENMPT_NAMESPACE::CHN_SYNCMUTE;
	sf->ChnSettings[ch].dwFlags.set( flags, mute );
	sf->m_PlayState.Chn[ch].dwFlags.set( flags, mute );
	for ( OPENMPT_NAMESPACE::CHANNELINDEX i = sf->GetNumChannels(); i < OPENMPT_NAMESPACE::MAX_CHANNELS; i++ ) {
		if ( sf->m_PlayState.Chn[i].nMasterChn == (OPENMPT_NAMESPACE::CHANNELINDEX) ( ch + 1 ) )
			sf->m_PlayState.Chn[i].dwFlags.set( flags, mute );
	}
	return 1;
}

} /* extern "C" */
