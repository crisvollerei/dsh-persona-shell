import test from 'node:test';
import assert from 'node:assert/strict';
import {makeReportSource} from '../lib/report-visualization.js';
import {createReportReadingPlan} from '../lib/report-reading.js';

const middle = text => {
  const source=makeReportSource({sessionId:'s',seq:1,text:`开头说明。\n\n${text}\n\n普通补充。`});
  const plan=createReportReadingPlan(source,{schemaVersion:2,annotations:[],reading:source.blocks.map(block=>({blockId:block.id,role:'detail',importance:3,relatedRefs:[]}))});
  return plan.entries[1];
};

test('neutral words do not turn a low priority middle paragraph into a protected condition',()=>{
  for(const value of ['这个布局不同于旧版。','在本次更新中统一配色。','未来可以继续美化。','需求描述了入口的位置。','刚才介绍了布局容器。','滚动衔接得很无缝。']){
    const entry=middle(value);assert.equal(entry.foldable,true,value);assert.equal(entry.reason,'detail',value);
  }
});

test('conditions, unavailable checks and approval boundaries cannot hide in the middle',()=>{
  for(const value of ['尚未验证线上服务。','测试没跑，不能据此发布。','只有用户确认后才执行。','在 Windows 环境下才支持。',
    '保存完成后再关闭页面。','未经批准不得删除文件。','这次只改了本地配置，不影响云端。','当前仅提供只读入口。',
    '需先安装 Node 20。','等待用户确认输出目录。','无证据说明已经生效。','When storage opens, retry.','No production tests were run.',
    '本次不提交、不推送。','目标机器未安装运行库。','该包需签名。','此入口仅接受本地文件。']){
    const entry=middle(value);assert.equal(entry.keep,true,value);assert.equal(entry.foldable,false,value);
  }
});
