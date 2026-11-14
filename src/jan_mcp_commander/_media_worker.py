"""Bounded offline codecs. Input is a byte snapshot, never a URL or file path."""
import base64
import io
import json
import logging
import math
import sys


def encoded(data):
    if len(data)>8*1024*1024: raise ValueError('Media output exceeds 8 MiB')
    return base64.b64encode(data).decode('ascii')


def preview(image):
    image=image.convert('RGB');image.thumbnail((1280,800))
    while True:
        output=io.BytesIO();image.save(output,format='JPEG',quality=65)
        # Two base64 previews plus metadata must fit the existing 1 MiB relay limit.
        if output.tell()<=250000:return {'type':'image','mimeType':'image/jpeg','data':encoded(output.getvalue())}
        image.thumbnail((max(16,image.width//2),max(16,image.height//2)))


def image_work(data, opts):
    from PIL import Image,ImageOps
    Image.MAX_IMAGE_PIXELS=25_000_000
    with Image.open(io.BytesIO(data)) as source:
        source.load()
        result={'kind':'image','format':source.format,'width':source.width,'height':source.height}
        image=source.convert('RGB').rotate(-opts['rotation'],expand=True)
        if opts['action']=='edit':image=ImageOps.contain(image,(opts['width'],opts['height']),Image.Resampling.LANCZOS)
        else:image.thumbnail((1280,800))
        output=io.BytesIO();image.save(output,format='JPEG',quality=80)
        if opts['action']=='edit':
            result.update(data=encoded(output.getvalue()),extension='.jpg',format='JPEG',width=image.width,height=image.height)
        else:
            result['images']=[preview(image)]
        return result


def open_media(data):
    import av
    # Byte input only; reject playlists and codecs that could open external references.
    return av.open(io.BytesIO(data),options={'protocol_whitelist':'','enable_drefs':'0',
        'format_whitelist':'wav,mp3,flac,ogg,aac,mov,matroska,webm,avi,asf'})


def audio_samples(data, opts):
    import av
    import numpy as np
    chunks=[];count=0;limit=int(opts['seconds']*16000)
    with open_media(data) as container:
        if not container.streams.audio:raise ValueError('No audio stream found')
        stream=container.streams.audio[0]
        resampler=av.AudioResampler(format='s16',layout='mono',rate=16000)
        if opts['start']:
            container.seek(int(opts['start']*av.time_base))
        for frame in container.decode(stream):
            for sample in resampler.resample(frame):
                values=sample.to_ndarray().reshape(-1)
                timestamp=sample.time
                if timestamp is None:
                    if opts['start']:raise ValueError('Cannot verify clip timestamps')
                    timestamp=count/16000
                offset=max(0,round((opts['start']-timestamp)*16000))
                end=min(len(values),round((opts['start']+opts['seconds']-timestamp)*16000))
                if end>offset:
                    selected=values[offset:end][:limit-count];chunks.append(selected);count+=len(selected)
                if count>=limit or timestamp>=opts['start']+opts['seconds']:break
            if count>=limit or (frame.time is not None and frame.time>=opts['start']+opts['seconds']):break
    if not chunks:raise ValueError('No audio in requested interval')
    return np.concatenate(chunks)


def audio_work(data,opts):
    import numpy as np
    samples=audio_samples(data,opts);floats=samples.astype(np.float32)/32768
    rms=float(np.sqrt(np.mean(floats**2)))
    result={'kind':'audio','sample_rate':16000,'channels':1,'start_seconds':opts['start'],
        'seconds':len(samples)/16000,'peak':float(np.max(np.abs(floats))),
        'rms_dbfs':round(20*math.log10(rms),2) if rms else None,'whole_file_analyzed':False}
    if opts['action']=='edit':
        import wave
        output=io.BytesIO()
        with wave.open(output,'wb') as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(samples.astype('<i2').tobytes())
        result.update(data=encoded(output.getvalue()),extension='.wav')
    elif opts['action']=='transcribe':
        from faster_whisper import WhisperModel
        model=WhisperModel(opts['model'],device='cpu',compute_type='int8',cpu_threads=2,num_workers=1,local_files_only=True)
        segments,info=model.transcribe(floats,beam_size=1,vad_filter=True)
        result['segments']=[];size=0
        for segment in segments:
            size+=len(segment.text.encode())
            if size>8192:raise ValueError('Transcript exceeds response limit')
            result['segments'].append({'start':round(opts['start']+segment.start,2),
                'end':round(opts['start']+segment.end,2),'text':segment.text})
        result.update(language=info.language,language_probability=info.language_probability,
            processing='offline',warning='Speech recognition can be inaccurate; verify important details.')
    return result


def video_work(data,opts):
    import av
    if opts['action']=='edit':return video_edit(data,opts)
    frames=[]
    with open_media(data) as container:
        if not container.streams.video:raise ValueError('No video stream found')
        stream=container.streams.video[0]
        if stream.width*stream.height>25_000_000:raise ValueError('Video dimensions exceed limit')
        result={'kind':'video','width':stream.width,'height':stream.height,
            'seconds':float(container.duration/av.time_base) if container.duration else None,
            'has_audio':bool(container.streams.audio),'whole_file_analyzed':False}
        for target in [opts['start'],opts['start']+opts['seconds']/2]:
            container.seek(int(target*av.time_base))
            for frame in container.decode(stream):
                if frame.time is not None and frame.time>=target:
                    frames.append(preview(frame.to_image()));break
        result['images']=frames
    if not frames:raise ValueError('No video frames in requested interval')
    return result


def video_edit(data,opts):
    import av
    import numpy as np
    from fractions import Fraction
    output=io.BytesIO();count=0;last_pts=-1
    with open_media(data) as source, av.open(output,'w',format='mp4') as target:
        if not source.streams.video:raise ValueError('No video stream found')
        stream=source.streams.video[0]
        if stream.width*stream.height>25_000_000:raise ValueError('Video dimensions exceed limit')
        rate=Fraction(str(min(30,max(1,float(stream.average_rate or 24))))).limit_denominator(1001)
        video=target.add_stream('libx264',rate=rate)
        ratio=min(1,1280/stream.width,720/stream.height,opts['width']/stream.width,opts['height']/stream.height)
        video.width=max(16,int(stream.width*ratio)//2*2);video.height=max(16,int(stream.height*ratio)//2*2)
        video.pix_fmt='yuv420p';video.bit_rate=1_000_000;video.options={'preset':'ultrafast'}
        has_audio=bool(source.streams.audio)
        if has_audio:
            audio=target.add_stream('aac',rate=16000);audio.layout='mono';audio.bit_rate=64000
        source.seek(int(opts['start']*av.time_base))
        for frame in source.decode(stream):
            if frame.time is None:raise ValueError('Cannot verify video timestamps')
            if frame.time+0.000001<opts['start']:continue
            if frame.time>=opts['start']+opts['seconds'] or count>=900:break
            pts=math.floor((frame.time-opts['start'])*float(rate)+0.000001)
            if pts<=last_pts:continue
            resized=frame.reformat(width=video.width,height=video.height,format='yuv420p')
            resized.pts=pts;resized.time_base=1/rate;count+=1;last_pts=pts
            for packet in video.encode(resized):target.mux(packet)
        for packet in video.encode():target.mux(packet)
        if not count:raise ValueError('No video in requested interval')
        if has_audio:
            samples=audio_samples(data,{**opts,'seconds':min(opts['seconds'],float((last_pts+1)/rate))})
            for offset in range(0,len(samples),1024):
                frame=av.AudioFrame.from_ndarray(samples[offset:offset+1024].astype(np.float32).reshape(1,-1)/32768,
                    format='fltp',layout='mono')
                frame.sample_rate=16000;frame.pts=offset;frame.time_base=Fraction(1,16000)
                for packet in audio.encode(frame):target.mux(packet)
            for packet in audio.encode():target.mux(packet)
    return {'kind':'video','data':encoded(output.getvalue()),'extension':'.mp4','frames':count,
        'seconds':float((last_pts+1)/rate),'has_audio':has_audio,'width':video.width,'height':video.height}


def main():
    from jan_mcp_commander.worker_limits import apply_limits
    job=apply_limits(1536)
    logging.disable(logging.CRITICAL)
    opts=json.loads(sys.argv[1]);data=sys.stdin.buffer.read(64*1024*1024+1)
    if len(data)>64*1024*1024:raise ValueError('Media input exceeds limit')
    if opts['kind']!='image':sys.path.insert(0,opts['runtime'])
    if opts['kind']=='image':return image_work(data,opts)
    if opts['kind']=='audio':return audio_work(data,opts)
    return video_work(data,opts)


if __name__=='__main__':
    try:print(json.dumps(main()))
    except Exception:
        print(json.dumps({'error':'Media could not be processed within supported format and resource limits; no output saved'}))
