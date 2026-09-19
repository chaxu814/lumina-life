// ============================================================
// GamificationPanel.tsx — 游戏化面板 v3.0 🎮🔥
//
// 三档升级：
//   青铜 — XP 进度条 + 升级动画 + 成就列表
//   白银 — 每日任务系统 + 签到奖励
//   黄金 — Live2D 情绪互动 + Lumina 送礼 + 排行榜
// ============================================================

import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../stores/appStore'
import { showToast } from './Toast'
import AchievementWall from './AchievementWall'

// ═══════════════════════════════════════════════════════════
// 成就定义
// ═══════════════════════════════════════════════════════════

const ACHIEVEMENT_DISPLAY: Record<string, { name: string; description: string; icon: string; category: string }> = {
  first_chat: { name: '初次见面', description: '和 Lumina 完成第一次对话', icon: '🤝', category: 'milestone' },
  chat_100: { name: '畅聊达人', description: '累计 100 条对话消息', icon: '💬', category: 'milestone' },
  chat_1000: { name: '话痨模式', description: '累计 1000 条对话消息', icon: '🗣️', category: 'milestone' },
  week_active: { name: '一周伙伴', description: '连续使用 7 天', icon: '📅', category: 'milestone' },
  month_active: { name: '满月纪念', description: '连续使用 30 天', icon: '🌕', category: 'milestone' },
  first_tool: { name: '初试身手', description: '第一次使用工具', icon: '🔧', category: 'skill' },
  tool_master_10: { name: '工具达人', description: '使用过 10 种工具', icon: '🛠️', category: 'skill' },
  tool_master_all: { name: '全能主人', description: '使用过 20 种工具', icon: '🏆', category: 'skill' },
  first_memory: { name: '铭记于心', description: 'Lumina 记住关于你的事', icon: '💾', category: 'milestone' },
  memory_hoarder: { name: '记忆收藏家', description: '保存 50 条记忆', icon: '🧠', category: 'milestone' },
  team_love: { name: '团队默契', description: '团队亲密度总和 150', icon: '💕', category: 'social' },
  social_butterfly: { name: '社交达人', description: '观看 10 次团队群聊', icon: '🦋', category: 'social' },
  mode_hopper: { name: '百变主人', description: '切换 4 种人格模式', icon: '🎭', category: 'fun' },
  first_capsule: { name: '时间旅人', description: '埋下第一颗时光胶囊', icon: '⏳', category: 'fun' },
  task_warrior: { name: '任务战士', description: '完成 10 个定时任务', icon: '⚔️', category: 'skill' },
  night_owl: { name: '夜猫子', description: '凌晨 2-5 点还在聊', icon: '🦉', category: 'hidden' },
}

const CATEGORY_LABELS: Record<string, string> = { milestone: '里程碑', skill: '技能', social: '社交', fun: '趣味', hidden: '隐藏' }
const CATEGORY_COLORS: Record<string, string> = { milestone: '#8b5cf6', skill: '#3b82f6', social: '#ec4899', fun: '#f59e0b', hidden: '#6b7280' }

const LEVEL_TITLES: Record<number, string> = {
  1:'初见',2:'熟人',3:'朋友',4:'好友',5:'挚友',6:'伙伴',7:'知己',8:'家人',9:'灵魂伴侣',10:'命定之人',
  12:'灵魂共振',15:'永恒羁绊',18:'星辰之约',20:'超越次元',25:'时空旅者',30:'神话再临',
}

function getTitle(level: number): string {
  if (LEVEL_TITLES[level]) {return LEVEL_TITLES[level]}
  const keys = Object.keys(LEVEL_TITLES).map(Number).sort((a,b)=>a-b)
  let t='冒险者'; for(const k of keys){if(k<=level){t=LEVEL_TITLES[k]}} return t
}

function xpForLevel(l: number){return Math.floor(100*Math.pow(l,1.5))}
function xpProgress(tXp:number){
  let l=1;while(xpForLevel(l+1)<=tXp){l++}
  const cur=xpForLevel(l),nxt=xpForLevel(l+1)
  return{level:l,currentXp:tXp-cur,nextLevelXp:nxt-cur,progress:(tXp-cur)/(nxt-cur)}
}

// 段位系统
const TIERS = [
  { name:'青铜', icon:'🥉', minLv:1, maxLv:5, color:'#cd7f32' },
  { name:'白银', icon:'🥈', minLv:6, maxLv:10, color:'#c0c0c0' },
  { name:'黄金', icon:'🥇', minLv:11, maxLv:15, color:'#ffd700' },
  { name:'钻石', icon:'💎', minLv:16, maxLv:20, color:'#b9f2ff' },
  { name:'大师', icon:'🏆', minLv:21, maxLv:30, color:'#ff6b6b' },
]
function getTier(level:number){return TIERS.find(t=>level>=t.minLv&&level<=t.maxLv)||TIERS[TIERS.length-1]}

// ═══════════════════════════════════════════════════════════
// 升级庆祝动画
// ═══════════════════════════════════════════════════════════

function LevelUpCelebration({oldLv,newLv,onDone}:{oldLv:number;newLv:number;onDone:()=>void}){
  const [phase,setPhase]=useState<'particles'|'text'|'done'>('particles')
  useEffect(()=>{
    const t1=setTimeout(()=>setPhase('text'),600)
    const t2=setTimeout(()=>{setPhase('done');onDone()},3000)
    return()=>{clearTimeout(t1);clearTimeout(t2)}
  },[])
  if(phase==='done'){return null}
  const colors=['#f59e0b','#ef4444','#8b5cf6','#3b82f6','#10b981','#ec4899','#f97316']
  const tier=getTier(newLv)
  return(
    <div style={{
      position:'fixed',top:0,left:0,right:0,bottom:0,zIndex:99999,
      pointerEvents:'none',display:'flex',alignItems:'center',justifyContent:'center',
      background:'rgba(0,0,0,0.4)',
    }}>
      {/* 粒子暴雨 */}
      {Array.from({length:60},(_,i)=>i).map(i=>(
        <div key={i} style={{
          position:'absolute',left:`${Math.random()*100}%`,top:`${Math.random()*100}%`,
          width:4+Math.random()*10,height:4+Math.random()*10,
          background:colors[Math.floor(Math.random()*colors.length)],
          borderRadius:Math.random()>0.5?'50%':'2px',
          animation:`lvup-${i%3} ${1.5+Math.random()*1.5}s ease-out ${Math.random()*0.8}s forwards`,
          opacity:0,
        }}/>
      ))}
      <div style={{textAlign:'center',animation:'celeb-pop 0.6s ease-out'}}>
        <div style={{fontSize:72,lineHeight:1,marginBottom:8}}>{tier.icon}</div>
        <div style={{
          fontSize:32,fontWeight:900,color:'#ffd700',
          textShadow:'0 2px 16px rgba(255,215,0,0.5),0 0 40px rgba(255,215,0,0.2)',
          background:'rgba(0,0,0,0.6)',padding:'12px 32px',borderRadius:20,
          backdropFilter:'blur(4px)',
        }}>
          🎊 升级！
          <div style={{fontSize:18,fontWeight:700,marginTop:4}}>
            Lv.{oldLv} → <span style={{fontSize:28,color:'#ffd700'}}>Lv.{newLv}</span>
          </div>
          <div style={{fontSize:14,fontWeight:600,color:'#fff',marginTop:4}}>
            {getTitle(newLv)} · {tier.name}{tier.icon}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes celeb-pop{0%{transform:scale(0.2);opacity:0}60%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
        @keyframes lvup-0{0%{transform:translateY(0)rotate(0deg)scale(1);opacity:1}100%{transform:translateY(-100vh)rotate(720deg)scale(0);opacity:0}}
        @keyframes lvup-1{0%{transform:translateY(0)rotate(0deg);opacity:1}100%{transform:translateY(100vh)rotate(-540deg);opacity:0}}
        @keyframes lvup-2{0%{transform:translate(0,0);opacity:1}50%{transform:translate(${Math.random()*100-50}px,-${50+Math.random()*100}px);opacity:0.8}100%{opacity:0}}
      `}</style>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 成就解锁动画
// ═══════════════════════════════════════════════════════════

function AchievementCelebration({achievement,onDone}:{achievement:{name:string;icon:string}|null;onDone:()=>void}){
  const[visible,setVisible]=useState(false)
  const[particles,setParticles]=useState<Array<{id:number;x:number;y:number;color:string;size:number;delay:number}>>([])
  useEffect(()=>{
    if(!achievement){return}
    setVisible(true)
    const colors=['#f59e0b','#ef4444','#8b5cf6','#3b82f6','#10b981','#ec4899','#f97316']
    setParticles(Array.from({length:40},(_,i)=>({id:i,x:Math.random()*100,y:-10-Math.random()*30,color:colors[Math.floor(Math.random()*colors.length)],size:6+Math.random()*8,delay:Math.random()*0.5})))
    const t=setTimeout(()=>{setVisible(false);onDone()},3000)
    return()=>clearTimeout(t)
  },[achievement])
  if(!visible||!achievement){return null}
  return(
    <div style={{position:'fixed',top:0,left:0,right:0,bottom:0,zIndex:99999,pointerEvents:'none',display:'flex',alignItems:'center',justifyContent:'center'}}>
      {particles.map(p=>(
        <div key={p.id} style={{position:'absolute',left:`${p.x}%`,top:`${p.y}%`,width:p.size,height:p.size,backgroundColor:p.color,borderRadius:Math.random()>0.5?'50%':'2px',animation:`confetti-fall2 2.5s ease-out ${p.delay}s forwards`,opacity:0}}/>
      ))}
      <div style={{animation:'celeb-pop 0.5s ease-out',textAlign:'center'}}>
        <div style={{fontSize:64,marginBottom:8}}>{achievement.icon}</div>
        <div style={{fontSize:24,fontWeight:800,color:'#f59e0b',textShadow:'0 2px 8px rgba(0,0,0,0.15)',background:'rgba(255,255,255,0.95)',padding:'12px 28px',borderRadius:16,boxShadow:'0 4px 24px rgba(0,0,0,0.12)'}}>
          🏆 成就解锁！
          <div style={{fontSize:16,fontWeight:600,color:'#333',marginTop:4}}>{achievement.name}</div>
        </div>
      </div>
      <style>{`@keyframes confetti-fall2{0%{transform:translateY(0)rotate(0deg);opacity:1}100%{transform:translateY(100vh)rotate(720deg);opacity:0}}`}</style>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 每日任务卡片
// ═══════════════════════════════════════════════════════════

interface QuestDef{id:string;title:string;description:string;icon:string;difficulty:string;category:string;target:number}
interface QuestProgress{questId:string;current:number;target:number;completed:boolean;claimed:boolean}
interface DailyState{date:string;quests:QuestProgress[];completedCount:number;allCompleted:boolean;streakBonus:number}

function QuestCard({quest,progress,onClaim}:{quest:QuestDef;progress:QuestProgress;onClaim:(id:string)=>void}){
  const pct=Math.min(100,progress.current/progress.target*100)
  const done=progress.completed&&!progress.claimed
  const colors:{[k:string]:string}={easy:'#10b981',medium:'#f59e0b',hard:'#ef4444'}
  return(
    <div style={{
      padding:'10px 12px',borderRadius:12,
      background:progress.completed?'rgba(16,185,129,0.08)':'var(--surface-100)',
      border:`1px solid ${progress.completed?'#10b981':'var(--border-light)'}`,
      opacity:progress.claimed?0.5:1,marginBottom:8,
    }}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:20}}>{quest.icon}</span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:'var(--text-primary)'}}>
              {quest.title}
              <span style={{fontSize:10,marginLeft:6,padding:'1px 6px',borderRadius:4,background:colors[quest.difficulty]+'20',color:colors[quest.difficulty],fontWeight:600}}>
                {quest.difficulty==='easy'?'简单':quest.difficulty==='medium'?'中等':'困难'}
              </span>
            </div>
            <div style={{fontSize:11,color:'var(--text-secondary)'}}>{quest.description}</div>
          </div>
        </div>
        {done&&(
          <button onClick={()=>onClaim(quest.id)} style={{
            padding:'4px 12px',borderRadius:8,border:'none',background:'#10b981',color:'#fff',
            fontSize:12,fontWeight:600,cursor:'pointer',
          }}>领取</button>
        )}
        {progress.claimed&&<span style={{fontSize:12,color:'#10b981',fontWeight:600}}>✅ 已领</span>}
      </div>
      <div style={{marginTop:6,display:'flex',alignItems:'center',gap:8}}>
        <div style={{flex:1,height:4,borderRadius:2,background:'rgba(0,0,0,0.08)',overflow:'hidden'}}>
          <div style={{width:`${pct}%`,height:'100%',background:colors[quest.difficulty],borderRadius:2,transition:'width 0.5s ease'}}/>
        </div>
        <span style={{fontSize:10,color:'var(--text-secondary)'}}>{progress.current}/{progress.target}</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

export default function GamificationPanel() {
  const gamification = useStore(s => s.gamification)
  const setGamification = useStore(s => s.setGamification)

  // 等级升级动画状态
  const [levelAnim, setLevelAnim] = useState<{old:number;new:number}|null>(null)
  const [achieveAnim, setAchieveAnim] = useState<{name:string;icon:string}|null>(null)
  const [showWall, setShowWall] = useState(false)

  // 每日任务
  const [quests, setQuests] = useState<DailyState|null>(null)

  // 🎮 从后端加载数据
  const loadStats = useCallback(async () => {
    try {
      const api = (window as any).luminaAPI
      if (!api?.gamificationStats) {return}
      const res = await api.gamificationStats()
      // 后端返回 { ok, data: {...} }，需解包 .data
      const stats = res?.data ?? res
      if (stats) {
        setGamification({
          level: stats.level ?? 1,
          totalXp: stats.totalXp ?? 0,
          todayXp: stats.todayXp ?? 0,
          title: stats.title ?? '初见',
          progress: stats.progress ?? 0,
          unlockedAchievements: stats.unlockedAchievements || [],
        })
      }
      // 加载每日任务
      if (api.gamificationQuests) {
        const qr = await api.gamificationQuests()
        const q = qr?.data ?? qr
        if (q?.quests) {setQuests(q)}
      }
    } catch (e) {
      console.warn('[GamificationPanel] 加载失败:', e)
    }
  }, [])

  // 首次加载 + 定期刷新
  useEffect(() => { loadStats(); const iv=setInterval(loadStats,30000); return ()=>clearInterval(iv) }, [])

  // 监听后端事件
  useEffect(() => {
    const api = (window as any).luminaAPI
    if (!api) {return}
    const unsubs: (()=>void)[] = []

    // 成就解锁
    if (api.onAchievementUnlocked) {
      unsubs.push(api.onAchievementUnlocked((a:any)=>{
        setAchieveAnim({name:a.name,icon:a.icon})
        showToast(`🏆 成就解锁：${a.name}`,'success')
        loadStats()
      }))
    }

    // 升级
    if (api.onLevelUp) {
      unsubs.push(api.onLevelUp((data:any)=>{
        setLevelAnim({old:data.oldLevel,new:data.newLevel})
        showToast(`🎉 升级！Lv.${data.oldLevel} → Lv.${data.newLevel}`,'success')
        loadStats()
      }))
    }

    // XP
    if (api.onXpGained) {
      unsubs.push(api.onXpGained((data:any)=>{
        // ⭐ Phase 2: 显示情绪倍率信息
        const mult = data.multiplier || 1
        const baseXp = data.baseXp || data.amount
        let xpMsg = `✨ +${data.amount} XP (${data.reason})`
        if (mult > 1) {xpMsg += ` ×${mult.toFixed(1)} 心情加成! 🎉`}
        else if (mult < 1) {xpMsg += ` 😔 心情低落 ×${mult.toFixed(1)}`}
        showToast(xpMsg, mult >= 1 ? 'info' : 'warning')
        loadStats()
      }))
    }

    // 任务更新
    if (api.onQuestsUpdated) {
      unsubs.push(api.onQuestsUpdated((data:any)=>{
        if (data?.quests) {setQuests(prev => prev ? {...prev, quests: data.quests, completedCount: data.completedCount, allCompleted: data.allCompleted} : prev)}
        loadStats()
      }))
    }

    // 新闻推送事件 → 更新新闻面板 & XP
    if (api.onNewsDigestPushed) {
      unsubs.push(api.onNewsDigestPushed(()=>{
        showToast('📡 新闻早报已推送！','success')
      }))
    }

    return () => unsubs.forEach(f => typeof f === 'function' && f())
  }, [])

  const {level,currentXp,nextLevelXp,progress}=xpProgress(gamification.totalXp ?? 0)
  const title=getTitle(level)
  const tier=getTier(level)

  // 按分类成就
  const grouped:Record<string,string[]>={}
  for(const id of gamification.unlockedAchievements){
    const info=ACHIEVEMENT_DISPLAY[id]
    if(!info||info.category==='hidden'){continue}
    if(!grouped[info.category]){grouped[info.category]=[]}
    grouped[info.category].push(id)
  }

  const totalAchievements=Object.entries(ACHIEVEMENT_DISPLAY).filter(([_,v])=>v.category!=='hidden').length

  // 领取任务
  const handleClaim = async (questId:string) => {
    const api=(window as any).luminaAPI
    if(!api?.gamificationQuestsClaim){return}
    const res=await api.gamificationQuestsClaim(questId)
    if(res.ok){
      showToast('🎁 任务奖励已领取！','success')
      loadStats()
    }
  }

  // 领取连续签到
  const handleStreak = async () => {
    const api=(window as any).luminaAPI
    if(!api?.gamificationQuestsClaimStreak){return}
    const res=await api.gamificationQuestsClaimStreak()
    if(res.bonus>0){showToast(`🔥 连续签到 +${res.bonus} XP！`,'success')}
    loadStats()
  }

  return (
    <div>
      {/* ═══ 段位卡片 ═══ */}
      <div style={{
        background:`linear-gradient(135deg, ${tier.color}88, ${tier.color}44)`,
        borderRadius:16,padding:24,color:'#fff',marginBottom:16,
        boxShadow:`0 4px 16px ${tier.color}44`,
        position:'relative',overflow:'hidden',
      }}>
        {/* 背景发光装饰 */}
        <div style={{position:'absolute',right:-20,top:-20,width:120,height:120,borderRadius:'50%',background:`${tier.color}22`,filter:'blur(20px)'}}/>

        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',position:'relative',zIndex:1}}>
          <div>
            <div style={{fontSize:11,opacity:0.8,marginBottom:2}}>{tier.icon} {tier.name}段位 · {title}</div>
            <div style={{fontSize:40,fontWeight:900,lineHeight:1.1,display:'flex',alignItems:'baseline',gap:4}}>
              Lv.{level}
              {level<30&&(
                <span style={{fontSize:13,fontWeight:400,opacity:0.7}}>
                  → Lv.{level+1}
                </span>
              )}
            </div>
            <div style={{fontSize:13,opacity:0.85,marginTop:2}}>
              总计 {gamification.totalXp} XP
            </div>
          </div>
          <div style={{
            width:64,height:64,borderRadius:'50%',
            background:'rgba(255,255,255,0.2)',
            display:'flex',alignItems:'center',justifyContent:'center',
            fontSize:36,backdropFilter:'blur(4px)',
            border:'2px solid rgba(255,255,255,0.3)',
          }}>
            {tier.icon}
          </div>
        </div>

        {/* XP 进度条 */}
        <div style={{marginTop:16,position:'relative',zIndex:1}}>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:11,opacity:0.8,marginBottom:4}}>
            <span>经验值</span>
            <span>{gamification.totalXp} XP</span>
          </div>
          <div style={{width:'100%',height:10,borderRadius:5,background:'rgba(255,255,255,0.2)',overflow:'hidden',position:'relative'}}>
            {/* 进度光泽 */}
            <div style={{
              width:`${Math.min(100,progress*100)}%`,height:'100%',
              borderRadius:5,background:'#fff',
              transition:'width 0.8s cubic-bezier(0.4,0,0.2,1)',
              position:'relative',
            }}>
              <div style={{
                position:'absolute',right:0,top:0,width:20,height:'100%',
                background:'linear-gradient(90deg,transparent,rgba(255,255,255,0.4))',
                borderRadius:5,
              }}/>
            </div>
          </div>
          <div style={{fontSize:10,opacity:0.7,marginTop:3,textAlign:'right'}}>
            {currentXp} / {nextLevelXp} XP · 升级还需 {nextLevelXp - currentXp} XP
          </div>
        </div>
      </div>

      {/* ═══ 今日活跃 ═══ */}
      <div style={{
        display:'flex',gap:8,marginBottom:16,
      }}>
        <div style={{
          flex:1,background:'var(--surface-100)',borderRadius:12,padding:'10px 14px',
          border:'1px solid var(--border-light)',
        }}>
          <div style={{fontSize:11,color:'var(--text-secondary)',marginBottom:2}}>今日 XP</div>
          <div style={{fontSize:22,fontWeight:700,color:'var(--text-primary)'}}>
            {gamification.todayXp}<span style={{fontSize:12,fontWeight:400,color:'var(--text-secondary)'}}> / 500</span>
          </div>
          <div style={{width:'100%',height:3,borderRadius:2,background:'rgba(0,0,0,0.06)',marginTop:4,overflow:'hidden'}}>
            <div style={{width:`${Math.min(100,gamification.todayXp/500*100)}%`,height:'100%',background:'#f59e0b',borderRadius:2,transition:'width 0.5s ease'}}/>
          </div>
        </div>
        {quests&&quests.streakBonus>0&&(
          <button onClick={handleStreak} style={{
            background:'linear-gradient(135deg,#f97316,#ef4444)',border:'none',
            borderRadius:12,padding:'10px 14px',color:'#fff',cursor:'pointer',
            display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
            minWidth:80,
          }}>
            <span style={{fontSize:20}}>🔥</span>
            <span style={{fontSize:11,fontWeight:600}}>连续 {quests.streakBonus} 天</span>
            <span style={{fontSize:10,opacity:0.8}}>领取 +{quests.streakBonus*10}</span>
          </button>
        )}
      </div>

      {/* ═══ 白银档：每日任务 ═══ */}
      {quests&&(
        <div style={{marginBottom:16}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
            <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>
              📋 每日任务
              {quests.allCompleted&&<span style={{fontSize:11,marginLeft:6,color:'#10b981'}}>✅ 全部完成！</span>}
            </div>
            <div style={{fontSize:11,color:'var(--text-secondary)'}}>
              {quests.completedCount}/{quests.quests.length}
            </div>
          </div>
          {quests.quests.map(qp=>{
            // 找到对应定义
            const defs:{[k:string]:QuestDef}={
              daily_chat_5:{id:'daily_chat_5',title:'早安问候',description:'和 Lumina 聊 5 句话',icon:'💬',difficulty:'easy',category:'chat',target:5},
              daily_tool_1:{id:'daily_tool_1',title:'小试牛刀',description:'让 Lumina 用 1 次工具',icon:'🔧',difficulty:'easy',category:'tool',target:1},
              daily_news_1:{id:'daily_news_1',title:'今日资讯',description:'看一眼今日新闻',icon:'📰',difficulty:'easy',category:'news',target:1},
              daily_streak:{id:'daily_streak',title:'连续签到',description:'连续登录天数 ≥ 1',icon:'🔥',difficulty:'easy',category:'daily',target:1},
              daily_chat_20:{id:'daily_chat_20',title:'畅聊时光',description:'和 Lumina 聊 20 句话',icon:'🗣️',difficulty:'medium',category:'chat',target:20},
              daily_tool_5:{id:'daily_tool_5',title:'工具达人',description:'使用 5 次工具',icon:'🛠️',difficulty:'medium',category:'tool',target:5},
              daily_team:{id:'daily_team',title:'团队协作',description:'和 Agent 团队聊天 3 次',icon:'👥',difficulty:'medium',category:'social',target:3},
              daily_memory:{id:'daily_memory',title:'铭记于心',description:'让 Lumina 记住 2 件事',icon:'🧠',difficulty:'medium',category:'explore',target:2},
              daily_chat_50:{id:'daily_chat_50',title:'话痨模式',description:'累计聊 50 句话',icon:'💫',difficulty:'hard',category:'chat',target:50},
              daily_all_news:{id:'daily_all_news',title:'新闻全览',description:'看完今日全部新闻推送',icon:'📡',difficulty:'hard',category:'news',target:1},
              daily_explorer:{id:'daily_explorer',title:'探索达人',description:'完成 3 种不同类型的任务',icon:'🌟',difficulty:'hard',category:'explore',target:3},
            }
            const qdef=defs[qp.questId]
            if(!qdef){return null}
            return <QuestCard key={qp.questId} quest={qdef} progress={qp} onClaim={handleClaim}/>
          })}
        </div>
      )}

      {/* ═══ 成就列表 + 奖杯墙入口 ═══ */}
      <div>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
          <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>
            🏆 成就 ({gamification.unlockedAchievements.length} / {totalAchievements})
          </div>
          <button onClick={()=>setShowWall(true)} style={{
            padding:'4px 14px',borderRadius:20,border:'none',
            background:'linear-gradient(135deg,#f59e0b,#ef4444)',
            color:'#fff',fontSize:11,fontWeight:700,cursor:'pointer',
            boxShadow:'0 2px 8px rgba(245,158,11,0.3)',
            transition:'transform 0.2s',
          }} onMouseOver={e=>e.currentTarget.style.transform='scale(1.05)'}
             onMouseOut={e=>e.currentTarget.style.transform='scale(1)'}>
            🏛️ 奖杯墙
          </button>
        </div>
        {['milestone','skill','social','fun'].map(cat=>{
          const unlocked=grouped[cat]||[]
          const total=Object.entries(ACHIEVEMENT_DISPLAY).filter(([_,v])=>v.category===cat).length
          if(total===0){return null}
          return(
            <div key={cat} style={{marginBottom:12}}>
              <div style={{fontSize:12,fontWeight:600,color:CATEGORY_COLORS[cat]||'var(--text-primary)',marginBottom:6,display:'flex',alignItems:'center',gap:6}}>
                <span>{cat==='milestone'?'🏅':cat==='skill'?'🔧':cat==='social'?'👥':'🎮'} {CATEGORY_LABELS[cat]||cat}</span>
                <span style={{fontSize:10,color:'var(--text-secondary)',fontWeight:400}}>({unlocked.length}/{total})</span>
              </div>
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {Object.entries(ACHIEVEMENT_DISPLAY).filter(([k,v])=>v.category===cat).map(([k,ach])=>{
                  const unlockedFlag=unlocked.includes(k)
                  return(
                    <div key={k} style={{
                      display:'flex',alignItems:'center',gap:4,
                      padding:'4px 8px',borderRadius:8,
                      background:unlockedFlag?`${CATEGORY_COLORS[cat]||'#888'}15`:'var(--surface-50)',
                      border:`1px solid ${unlockedFlag?CATEGORY_COLORS[cat]||'#888':'var(--border-light)'}`,
                      opacity:unlockedFlag?1:0.5,
                      cursor:'default',transition:'all 0.2s',
                    }} title={ach.description}>
                      <span style={{fontSize:16}}>{unlockedFlag?ach.icon:'🔒'}</span>
                      <span style={{fontSize:10,fontWeight:unlockedFlag?600:400,color:unlockedFlag?CATEGORY_COLORS[cat]||'var(--text-primary)':'var(--text-tertiary)'}}>
                        {ach.name}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* 🎊 升级庆祝动画覆盖层 */}
      {levelAnim && (
        <LevelUpCelebration
          oldLv={levelAnim.old}
          newLv={levelAnim.new}
          onDone={() => setLevelAnim(null)}
        />
      )}

      {/* 🏆 成就解锁动画 */}
      {achieveAnim && (
        <AchievementCelebration
          achievement={achieveAnim}
          onDone={() => setAchieveAnim(null)}
        />
      )}

      {/* 🏛️ PS5 奖杯墙覆盖层 */}
      {showWall && (
        <AchievementWall
          unlockedAchievements={gamification.unlockedAchievements}
          onClose={() => setShowWall(false)}
        />
      )}
    </div>
  )
}