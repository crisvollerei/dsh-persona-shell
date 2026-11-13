import {createHash} from 'node:crypto';
export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
export const upload={mediaType:'image/png',data:png.toString('base64'),name:'example.png'};
/** In-memory attachment capability for controlled Host tests; not a raster decoder. */
export function imageStore(){
 const files=new Map(),saved=[];
 return {files,saved,async saveImages(images){return images.map(image=>{
   if(image.mediaType!=='image/png'||!Buffer.from(image.data).subarray(0,8).equals(png.subarray(0,8)))throw Error('invalid-raster');
   const bytes=Buffer.from(image.data),attachmentId=createHash('sha256').update(bytes).digest('hex');
   const ref={attachmentId,mediaType:image.mediaType,width:1,height:1,bytes:bytes.length,...(image.name?{name:image.name}:{})};
   files.set(attachmentId,bytes);saved.push(ref);return ref;
 });},
 async readImage(ref){const data=files.get(ref.attachmentId);if(!data)throw Error('missing-raster');return{ref,data};}
 };
}
