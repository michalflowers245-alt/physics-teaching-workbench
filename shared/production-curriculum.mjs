import {readFileSync} from 'node:fs';

const curriculumFile=process.env.PANEL_CURRICULUM_FILE;
const curriculum=curriculumFile ? JSON.parse(readFileSync(curriculumFile,'utf8')) : {};

export function scheduledTopic({grade,year,term,lessonNo}){
  const title=curriculum?.[year]?.[term]?.[grade]?.[Number(lessonNo)-1];
  return typeof title==='string' ? title : '';
}
