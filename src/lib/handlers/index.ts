import type {FormatHandler} from '../types';
import {cleanJpeg, inspectJpeg} from './jpeg';
import {cleanPng, inspectPng} from './png';
import {cleanWebp, inspectWebp} from './webp';
import {cleanGif, inspectGif} from './gif';
import {cleanTiff, inspectTiff} from './tiff';
import {cleanHeic, inspectHeic} from './heic';
import {cleanMp4, inspectMp4} from './mp4';
import {cleanPdf, inspectPdf} from './pdf';
import {cleanOffice, inspectOffice} from './office';
import {cleanWebm, inspectWebm} from './webm';
import {cleanAvi, inspectAvi} from './avi';

export const handlers: Record<string, FormatHandler> = {
  jpeg: {format: 'jpeg', inspect: inspectJpeg, clean: cleanJpeg},
  png: {format: 'png', inspect: inspectPng, clean: cleanPng},
  webp: {format: 'webp', inspect: inspectWebp, clean: cleanWebp},
  gif: {format: 'gif', inspect: inspectGif, clean: cleanGif},
  tiff: {format: 'tiff', inspect: inspectTiff, clean: cleanTiff},
  heic: {format: 'heic', inspect: inspectHeic, clean: cleanHeic},
  mp4: {format: 'mp4', inspect: inspectMp4, clean: cleanMp4},
  pdf: {format: 'pdf', inspect: inspectPdf, clean: cleanPdf},
  office: {format: 'office', inspect: inspectOffice, clean: cleanOffice},
  webm: {format: 'webm', inspect: inspectWebm, clean: cleanWebm},
  avi: {format: 'avi', inspect: inspectAvi, clean: cleanAvi},
};

export function getHandler(format: string): FormatHandler | undefined {
  return handlers[format];
}
