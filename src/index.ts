export type Chunk={type:string;data:Uint8Array;crc:number};export function readChunk(input:Uint8Array):Chunk|null{if(input.length<12)return null;const length=(input[0]<<24)|(input[1]<<16)|(input[2]<<8)|input[3];if(length<0||input.length<12+length)return null;const type=new TextDecoder().decode(input.slice(4,8));return{type,data:input.slice(8,8+length),crc:0}}export function paeth(a:number,b:number,c:number){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
export {
	ALLOWED_BIT_DEPTHS,
	PngParser,
	PngStructureError,
	chunkFlags,
	parsePng,
} from './png.js';
export type {
	ChunkFlags,
	DocumentPhase,
	IHDRInfo,
	PngDocument,
	PngErrorDetails,
	PngParserOptions,
	SeenChunk,
} from './png.js';
