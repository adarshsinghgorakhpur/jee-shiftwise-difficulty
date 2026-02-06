/**
 * JEE 2026 Shift Analytics - Performance Alpha Edition (Comprehensive Engine)
 * * This script handles:
 * 1. LIVE DATA SYNCHRONIZATION: Fetching and processing shift data from the Mathongo API.
 * 2. ADVANCED STATISTICAL MODELING: 
 * - Median and Strict Mean calculation.
 * - Population Spread (Standard Deviation and Skewness).
 * - Percentile Predictor via Localized Exponential Decay Interpolation.
 * 3. DYNAMIC UI RENDERING:
 * - Leaderboard ranking with percentile anchors.
 * - Subject-specific difficulty standings.
 * - Synchronized Chart.js visualizations (Comparison, Subject-Stacks, and Distribution).
 * 4. INTERACTIVE CONTROLS: Sorting, visibility toggles, and real-time score prediction.
 */

// --- CONFIGURATION & CONSTANTS ---

const API_URL = 'https://api.jee-marks-calculator.mathongo.com/score';
const BEARER_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFrYXNoZGVlcDEyMmFAZ21haWwuY29tIiwidXNlclJlc3BvbnNlS2V5VXJsIjoiaHR0cHM6Ly9jZG4zLmRpZ2lhbG0uY29tLy9wZXIvZzI4L3B1Yi8yMDgzL3RvdWNoc3RvbmUvQXNzZXNzbWVudFFQSFRNTE1vZGUxLy8yMDgzTzI1MjQ5LzIwODNPMjUyNDlTNkQxMDI2MC8xNzY5NDI3MzIyNjg0ODUxMS9VUDA5MDIwNjU1N18yMDgzTzI1MjQ5UzZEMTAyNjBFMS5odG1sIyIsImlhdCI6MTc3MDIyMzIxMywiZXhwIjoxNzcyODE1MjEzfQ.vT5ibLvRqh3gYnDSbYJr453Atm7k-7dQqN3P-RERiBA';
const PAYLOAD = {
    "userResponseKeyUrl": "https://cdn3.digialm.com//per/g28/pub/2083/touchstone/AssessmentQPHTMLMode1//2083O25249/2083O25249S6D10260/17694273226848511/UP090206557_2083O25249S6D10260E1.html#"
};

// Score buckets used for distribution and interpolation
const BUCKET_LABELS = ["0-25", "25-50", "50-75", "75-100", "100-125", "125-150", "150-175", "175-200", "200-225", "225-250", "250-275", "275-300"];

// --- GLOBAL STATE ---

let barChart, distChart, subjectChart;
let processedData = [];
let selectedShiftData = null;
let chartSortMode = 'date'; // 'date' or 'mean'
let currentSubjectIndex = 0; // Rotates through P, C, M for the toughest card
let show150Line = true;
let show99Line = true;
let show98Line = true;

const subjects = [{
        key: 'p',
        label: 'Physics Toughest',
        color: 'text-purple-400',
        hex: '#a371f7'
    },
    {
        key: 'c',
        label: 'Chemistry Toughest',
        color: 'text-green-400',
        hex: '#3fb950'
    },
    {
        key: 'm',
        label: 'Maths Toughest',
        color: 'text-red-400',
        hex: '#f85149'
    }
];

// --- CORE STATISTICAL ENGINE ---


function getBiasedStats(segments) {
    let totalCount = 0;
    let weightedSum = 0;
    const labels = ["0-25", "25-50", "50-75", "75-100", "100-125", "125-150", "150-175", "175-200"];

    // Step 1: Weighted Mean (2.5x Bias on 0-25)
    labels.forEach((label, i) => {
        let count = Number(segments[label] ? .provisionalCount) || 0;
        let adjCount = (i === 0) ? count * 2.5 : count;
        let midpoint = (i * 25) + 12.5;

        totalCount += adjCount;
        weightedSum += adjCount * midpoint;
    });

    const mean = weightedSum / totalCount;

    // Step 2: Standard Deviation
    let varianceSum = 0;
    labels.forEach((label, i) => {
        let count = Number(segments[label] ? .provisionalCount) || 0;
        let adjCount = (i === 0) ? count * 2.5 : count;
        let midpoint = (i * 25) + 12.5;

        varianceSum += adjCount * Math.pow(midpoint - mean, 2);
    });

    const sd = Math.sqrt(varianceSum / totalCount);

    return {
        mean,
        sd
    };
}

/**
 * Implements the Marks-to-Percentile Logic via Exponential Decay Interpolation.
 * Formula: Rank_within = R_top * e^(k * (Score_high - Score_user))
 * where k = ln(R_bottom / R_top) / 25
 */
function runPercentileLogic() {
    const input = document.getElementById('user-marks-input');
    const display = document.getElementById('predicted-percentile-display');
    const score = parseFloat(input.value);

    // Basic Validation
    if (isNaN(score) || !selectedShiftData || score < 0 || score > 300) {
        display.innerText = "---";
        return;
    }

    // Step A: Locate the Bucket (e.g., 165 falls into 150-175)
    const bucketIdx = Math.min(Math.floor(score / 25), 11);
    const label = BUCKET_LABELS[bucketIdx];
    const scoreHigh = (bucketIdx + 1) * 25;

    // Step B: Calculate Cumulative Count of all students scoring ABOVE this bucket
    let totalAbove = 0;
    for (let i = 11; i > bucketIdx; i--) {
        totalAbove += Number(selectedShiftData.segments[BUCKET_LABELS[i]] ? .provisionalCount) || 0;
    }

    // Step C: Localized Interpolation
    const countInBucket = Number(selectedShiftData.segments[label] ? .provisionalCount) || 0;

    // Use epsilon to prevent Log(0) errors
    const rTop = Math.max(0.5, totalAbove);
    const rBottom = rTop + Math.max(0.5, countInBucket);

    // Calculate the localized decay constant 'k' for this 25-mark window
    const k = Math.log(rBottom / rTop) / 25;
    const distanceToTop = scoreHigh - score;

    // Exponential Rank Placement (Rank in Sample)
    const rankWithin = rTop * Math.exp(k * distanceToTop);

    // Step D: Map Sample Rank to Population Percentile
    const totalStudents = selectedShiftData.count;
    const samplePercentageAbove = (rankWithin / totalStudents) * 100;

    /**
     * Non-linear Mapping (Calibration):
     * - Top 6.5% of sample -> Top 1% of Exam (99%ile)
     * - Top 12.5% of sample -> Top 2% of Exam (98%ile)
     */
    let examTopPercentage;

    if (samplePercentageAbove <= 6.5) {
        const relPos = samplePercentageAbove / 6.5;

        // Difficulty-influenced damping factors
        // Base exponent now reacts slightly to shift average to pre-smooth the curve
        const baseExp = 1.25 + (selectedShiftData.avg / 1200);
        const ultraDamping = Math.max(0.75, 1.25 - (selectedShiftData.avg / 280));

        // 1. Calculate the "Elite" logic result (starting from 99.0)
        const eliteVal = Math.pow(relPos, baseExp);

        // 2. Calculate the "Ultra-Elite" logic result (the high-end anchor)
        const boundaryVal = Math.pow(0.4, baseExp);
        const ultraRelPos = relPos / 0.4;
        const ultraEliteVal = boundaryVal * Math.pow(ultraRelPos, ultraDamping);

        // 3. THE LONG HANDOVER (Smoothening above 99.45)
        // Window expanded: Starts at 0.65 (~99.45%ile) and ends at 0.35
        // This prevents the "kink" by blending the formulas over a 30% wider range.
        const lowerBound = 0.35;
        const upperBound = 0.65;

        if (relPos > upperBound) {
            // Standard Elite Logic
            examTopPercentage = eliteVal;
        } else if (relPos < lowerBound) {
            // Full Ultra-Elite Damping
            examTopPercentage = ultraEliteVal;
        } else {
            // DYNAMIC BLEND:
            // The further you go above 99.45, the more the Ultra-Elite 
            // difficulty-based damping takes over.
            const blendWeight = (relPos - lowerBound) / (upperBound - lowerBound);

            examTopPercentage = (eliteVal * blendWeight) + (ultraEliteVal * (1 - blendWeight));
        }
    } else if (samplePercentageAbove <= 11.75) {
        // Linear interpolation between 99%ile and 98%ile markers
        const t = (samplePercentageAbove - 6.5) / (11.75 - 6.5);
        examTopPercentage = 1.0 + t * (2.0 - 1.0);
    } // --- ZONE 2 & 3: BIASED POPULATION ZONE (Synchronized with Python Engine) ---
    else {
        // Uses the 2.5x bias logic to calculate mean and sd
        const stats = getBiasedStats(selectedShiftData.segments);

        // Matches Python Anchor: p90_anchor = biased_mean + (0.4 * biased_sd)
        const p90AnchorScore = stats.mean + (0.38 * stats.sd);
        //console.log("P90 Anchor:", p90AnchorScore, "Biased SD:", stats.sd, "Normal Mean:", stats.mean);
        const p98Score = selectedShiftData.predicted98;

        if (score >= p90AnchorScore) {
            /**
             * ZONE 2: LOG-K BRIDGE (98%ile to 90%ile)
             * Exponential bridge between Sample Elite and Population Anchor.
             */
            const scoreDiff = p98Score - p90AnchorScore;
            const k_bridge = Math.log(10.0 / 2.0) / Math.max(1, scoreDiff);
            const distanceToP98 = p98Score - score;

            examTopPercentage = 2.0 * Math.exp(k_bridge * distanceToP98);

        } else if (score >= (p90AnchorScore - (0.5 * stats.sd))) {
            /**
             * ZONE 3: THE DYNAMIC BUFFER (P90 to Cliff Edge)
             * Drops exactly 10 percentiles (from 90th to 80th) over a 0.5 SD width.
             */
            const cliffEdge = p90AnchorScore - (0.5 * stats.sd);
            const t = (p90AnchorScore - score) / Math.max(1, p90AnchorScore - cliffEdge);

            examTopPercentage = 10.0 + (t * 10.0);

        } else {
            /**
             * ZONE 4: THE DELAYED GRAVITY (Smooth top, sharp bottom)
             * Smoothens out initially, then accelerates the drop near the floor.
             */
            const cliffEdge = p90AnchorScore - (0.5 * stats.sd);

            // Normalize the distance: 0 at the edge, 1 at score 0
            const t = (cliffEdge - score) / Math.max(1, cliffEdge);

            // Using t squared (t^2) creates that "slow start, fast finish" feel
            // This looks like x² = 4ay near the origin
            examTopPercentage = 20.0 + (75.0 * Math.pow(t, 2));
        }
    }

    // Final Percentile Calculation
    let percentile = 100 - examTopPercentage;

    // Score threshold logic: cap non-perfect scores to avoid early 100s
    if (score < 290) {
        if (percentile >= 99.99) {
            display.innerText = "99.99+";
        } else {
            display.innerText = percentile.toFixed(2) + "%";
        }
    } else {
        percentile = Math.max(99.99, Math.min(100.00, percentile));
        display.innerText = percentile.toFixed(2) + "%";
    }
}

/**
 * Calculates higher-order statistics (Mean, Standard Deviation, Skewness) 
 * for the population distribution using bucket midpoints.
 */
function calculateDetailedStats(segments) {
    let totalCount = 0;
    let weightedSum = 0;

    BUCKET_LABELS.forEach((label, index) => {
        const count = Number(segments[label] ? .provisionalCount) || 0;
        const midpoint = (index * 25) + 12.5;
        totalCount += count;
        weightedSum += count * midpoint;
    });

    if (totalCount === 0) return {
        mean: 0,
        sd: 0,
        skew: 0
    };

    const mean = weightedSum / totalCount;
    let varianceSum = 0;
    let skewnessSum = 0;

    BUCKET_LABELS.forEach((label, index) => {
        const count = Number(segments[label] ? .provisionalCount) || 0;
        const midpoint = (index * 25) + 12.5;
        const deviation = midpoint - mean;

        varianceSum += count * Math.pow(deviation, 2);
        skewnessSum += count * Math.pow(deviation, 3);
    });

    const variance = varianceSum / totalCount;
    const sd = Math.sqrt(variance);

    const skew = sd > 0 ? (skewnessSum / totalCount) / Math.pow(sd, 3) : 0;

    return {
        mean,
        sd,
        skew
    };
}

/**
 * Predicts the score required for a specific top percentage (e.g., 6.5% for 99%ile).
 */
function calculateScoreForTopPercentage(segments, targetPercentage) {
    let totalCount = 0;
    const counts = BUCKET_LABELS.map(label => {
        const c = Number(segments[label] ? .provisionalCount) || 0;
        totalCount += c;
        return c;
    });

    if (totalCount < 50) return 0;

    const targetRank = totalCount * (targetPercentage / 100);
    let cumulativeRankAbove = 0;
    let targetIdx = -1;

    for (let i = 11; i >= 0; i--) {
        let bucketRankBottom = cumulativeRankAbove + counts[i];
        if (targetRank >= cumulativeRankAbove && targetRank <= bucketRankBottom) {
            targetIdx = i;
            break;
        }
        cumulativeRankAbove = bucketRankBottom;
    }

    if (targetIdx === -1) return 0;

    const scoreHigh = (targetIdx + 1) * 25;
    const rTop = Math.max(0.5, cumulativeRankAbove);
    const rBottom = rTop + Math.max(0.5, counts[targetIdx]);

    const k = Math.log(rBottom / rTop) / 25;
    const distanceToTop = Math.log(targetRank / rTop) / k;

    return Number(Math.max(scoreHigh - 25, Math.min(scoreHigh, scoreHigh - distanceToTop)).toFixed(1));
}

/**
 * Calculates the exact median score by finding the 50th percentile student.
 */
function calculateMedian(segments) {
    let total = Object.values(segments).reduce((acc, curr) => acc + (Number(curr.provisionalCount) || 0), 0);
    if (total === 0) return 0;

    let midIndex = total / 2;
    let runningSum = 0;

    for (let i = 0; i < 12; i++) {
        let count = Number(segments[BUCKET_LABELS[i]] ? .provisionalCount) || 0;
        if (runningSum + count >= midIndex) {
            let positionInBucket = midIndex - runningSum;
            let percentageThrough = positionInBucket / count;
            return Number(((i * 25) + (percentageThrough * 25)).toFixed(2));
        }
        runningSum += count;
    }
    return 0;
}

// --- DATA PROCESSING & UI INJECTION ---

async function initData() {
    const status = document.getElementById('sync-status');
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BEARER_TOKEN}`
            },
            body: JSON.stringify(PAYLOAD)
        });
        const json = await res.json();

        if (json.success) {
            render(json.data.comparativeScores);
            status.innerText = 'Live Feed Active';
            status.className = 'text-green-500 font-bold';
        } else {
            throw new Error("API responded with success:false");
        }
    } catch (e) {
        console.error("Shift Analytics Sync Error:", e);
        status.innerText = 'Offline / CORS Blocked';
        status.className = 'text-red-400 font-bold';
    }
}

function render(scores) {
    let totalStudents = 0;
    let mediansSum = 0;
    let topStudentsCount = 0;

    processedData = scores.map(s => {
        const count = Object.values(s.segments).reduce((acc, curr) => acc + (Number(curr.provisionalCount) || 0), 0);
        const totalAvg = (s.avgProvisionalPhysicsMarks || 0) + (s.avgProvisionalChemistryMarks || 0) + (s.avgProvisionalMathematicsMarks || 0);

        const eliteCount = ["150-175", "175-200", "200-225", "225-250", "250-275", "275-300"].reduce((acc, k) => acc + (s.segments[k] ? .provisionalCount || 0), 0);

        const stats = calculateDetailedStats(s.segments);

        return {
            id: s._id.replace(/\s+/g, ' ').trim(),
            avg: Number(totalAvg.toFixed(1)),
            median: calculateMedian(s.segments),
            sd: Number(stats.sd.toFixed(2)),
            skew: Number(stats.skew.toFixed(3)),
            predicted99: calculateScoreForTopPercentage(s.segments, 6.5),
            predicted98: calculateScoreForTopPercentage(s.segments, 11.75),
            p: s.avgProvisionalPhysicsMarks || 0,
            c: s.avgProvisionalChemistryMarks || 0,
            m: s.avgProvisionalMathematicsMarks || 0,
            eliteRatio: Number(((eliteCount / count) * 100).toFixed(2)),
            segments: s.segments,
            count: count
        };
    }).filter(s => s.count > 100).sort((a, b) => a.avg - b.avg);

    processedData.forEach(s => {
        totalStudents += s.count;
        mediansSum += s.median;
        topStudentsCount += (s.eliteRatio * s.count / 100);
    });

    document.getElementById('total-students-count').innerText = totalStudents.toLocaleString();
    document.getElementById('global-median').innerText = (mediansSum / processedData.length).toFixed(1);
    document.getElementById('global-top-ratio').innerText = ((topStudentsCount / totalStudents) * 100).toFixed(2) + "%";

    const toughestShift = processedData[0];
    document.getElementById('hardest-shift').innerText = toughestShift.id;
    document.getElementById('hardest-mean-val').innerText = toughestShift.avg;
    document.getElementById('hardest-median-val').innerText = toughestShift.median;

    updateSubjectToughestCard();
    renderSubjectDistributionRanks();
    renderLeaderboard();

    renderMainComparison();
    renderSubjectAnalysis();

    if (processedData.length > 0 && !selectedShiftData) updateCharts(processedData[0]);
}

function renderLeaderboard() {
    const lb = document.getElementById('leaderboard');
    lb.innerHTML = '';

    processedData.forEach((s, i) => {
        const isActive = selectedShiftData && selectedShiftData.id === s.id;
        const card = document.createElement('div');
        card.className = `shift-card p-3 flex justify-between items-center cursor-pointer group ${isActive ? 'active shadow-[0_0_15px_rgba(88,166,255,0.1)]' : ''}`;

        card.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="rank-gradient w-7 h-7 rounded-full flex items-center justify-center font-bold text-white text-[10px] shadow-lg shrink-0">${i+1}</span>
                <div>
                   <p class="font-bold text-xs ${isActive ? 'text-blue-400' : 'text-gray-100'}">${s.id}</p>
                   <div class="flex gap-1.5 mt-1.5">
                       <span class="text-[7.5px] px-1.5 py-0.5 rounded bg-red-900/20 border border-red-900/40 text-red-400 font-bold uppercase">P99: ${s.predicted99}</span>
                       <span class="text-[7.5px] px-1.5 py-0.5 rounded bg-orange-900/20 border border-orange-900/40 text-orange-400 font-bold uppercase">P98: ${s.predicted98}</span>
                   </div>
                </div>
            </div>
            <div class="flex flex-col items-end gap-1.5 shrink-0 ml-auto">
                <div class="flex gap-3 mb-0.5">
                    <div class="text-right">
                        <p class="text-[8px] text-gray-500 font-bold uppercase leading-none">Mean</p>
                        <p class="text-xs font-mono font-bold text-blue-400 leading-none mt-1.5">${s.avg}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-[8px] text-gray-500 font-bold uppercase leading-none">Med</p>
                        <p class="text-xs font-mono font-bold text-white leading-none mt-1.5">${s.median}</p>
                    </div>
                </div>
                <span class="text-[7.5px] px-1.5 py-0.5 rounded top-tier-badge font-bold uppercase tracking-tight">Elite: ${s.eliteRatio}%</span>
            </div>`;

        card.onclick = () => {
            updateCharts(s);
        };
        lb.appendChild(card);
    });
}

function renderMainComparison() {
    const ctx = document.getElementById('barChart').getContext('2d');
    if (barChart) barChart.destroy();

    let chartData = [...processedData];
    if (chartSortMode === 'date') {
        chartData.sort((a, b) => getChronologicalVal(a.id) - getChronologicalVal(b.id));
    } else {
        chartData.sort((a, b) => a.avg - b.avg);
    }

    const selectedId = selectedShiftData ? selectedShiftData.id : null;

    const datasets = [{
            label: 'Median',
            data: chartData.map(d => d.median),
            backgroundColor: chartData.map(d => d.id === selectedId ? '#58a6ff' : 'rgba(88, 166, 255, 0.4)'),
            borderColor: chartData.map(d => d.id === selectedId ? '#ffffff' : 'transparent'),
            borderWidth: chartData.map(d => d.id === selectedId ? 1.5 : 0),
            order: 10,
            barPercentage: 0.6
        },
        {
            label: 'Mean',
            data: chartData.map(d => d.avg),
            backgroundColor: chartData.map(d => d.id === selectedId ? '#444c56' : 'rgba(48, 54, 61, 0.6)'),
            borderColor: chartData.map(d => d.id === selectedId ? '#ffffff' : 'transparent'),
            borderWidth: chartData.map(d => d.id === selectedId ? 1 : 0),
            order: 11,
            barPercentage: 0.8
        }
    ];

    if (show150Line) {
        datasets.push({
            label: '150+ Ratio (%)',
            data: chartData.map(d => d.eliteRatio),
            borderColor: '#f1e05a',
            borderWidth: 2,
            type: 'line',
            tension: 0.4,
            pointRadius: chartData.map(d => d.id === selectedId ? 5 : 2),
            pointBackgroundColor: chartData.map(d => d.id === selectedId ? '#ffffff' : '#f1e05a'),
            order: 0,
            yAxisID: 'y1'
        });
    }
    if (show99Line) {
        datasets.push({
            label: '99%ile Target',
            data: chartData.map(d => d.predicted99),
            borderColor: '#f85149',
            borderWidth: 2,
            type: 'line',
            tension: 0.3,
            order: 1
        });
    }
    if (show98Line) {
        datasets.push({
            label: '98%ile Target',
            data: chartData.map(d => d.predicted98),
            borderColor: '#fb8c00',
            borderWidth: 2,
            type: 'line',
            tension: 0.3,
            order: 2
        });
    }

    barChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartData.map(d => d.id),
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    grid: {
                        color: 'rgba(48, 54, 61, 0.4)'
                    },
                    ticks: {
                        color: '#8b949e',
                        font: {
                            size: 10
                        }
                    }
                },
                y1: {
                    position: 'right',
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: '#f1e05a',
                        font: {
                            size: 9
                        },
                        callback: (v) => v + '%'
                    },
                    max: 35
                },
                x: {
                    ticks: {
                        color: '#8b949e',
                        font: {
                            size: 9
                        },
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            }
        }
    });
}

function renderSubjectAnalysis() {
    const ctx = document.getElementById('subjectChart').getContext('2d');
    if (subjectChart) subjectChart.destroy();

    let chartData = [...processedData];
    if (chartSortMode === 'date') {
        chartData.sort((a, b) => getChronologicalVal(a.id) - getChronologicalVal(b.id));
    } else {
        chartData.sort((a, b) => a.avg - b.avg);
    }

    const selectedId = selectedShiftData ? selectedShiftData.id : null;

    subjectChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartData.map(d => d.id),
            datasets: [{
                    label: 'Physics',
                    data: chartData.map(d => d.p),
                    backgroundColor: chartData.map(d => d.id === selectedId ? '#a371f7' : 'rgba(163, 113, 247, 0.4)')
                },
                {
                    label: 'Chemistry',
                    data: chartData.map(d => d.c),
                    backgroundColor: chartData.map(d => d.id === selectedId ? '#3fb950' : 'rgba(63, 185, 80, 0.4)')
                },
                {
                    label: 'Maths',
                    data: chartData.map(d => d.m),
                    backgroundColor: chartData.map(d => d.id === selectedId ? '#f85149' : 'rgba(248, 81, 73, 0.4)')
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    stacked: true,
                    ticks: {
                        display: false
                    },
                    grid: {
                        display: false
                    }
                },
                y: {
                    stacked: true,
                    grid: {
                        color: 'rgba(48, 54, 61, 0.2)'
                    },
                    ticks: {
                        color: '#8b949e',
                        font: {
                            size: 10
                        }
                    }
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#8b949e',
                        boxWidth: 10,
                        font: {
                            size: 10
                        }
                    }
                }
            }
        }
    });
}

function updateCharts(s) {
    selectedShiftData = s;
    document.getElementById('dist-shift-id').innerText = s.id;
    document.getElementById('dist-sample-size').innerText = `${s.count.toLocaleString()} students`;
    document.getElementById('top-tier-stat').innerText = `150+ Elite: ${s.eliteRatio}%`;
    document.getElementById('predicted-99-stat').innerText = `P99: ${s.predicted99}`;
    document.getElementById('predicted-98-stat').innerText = `P98: ${s.predicted98}`;

    runPercentileLogic();
    renderMainComparison();
    renderSubjectAnalysis();
    renderLeaderboard();

    const ctxDist = document.getElementById('distChart').getContext('2d');
    if (distChart) distChart.destroy();

    const plotData = BUCKET_LABELS.map(l => Number(s.segments[l] ? .provisionalCount) || 0);

    distChart = new Chart(ctxDist, {
        type: 'line',
        data: {
            labels: BUCKET_LABELS,
            datasets: [{
                data: plotData,
                borderColor: '#238636',
                backgroundColor: 'rgba(35, 134, 54, 0.1)',
                fill: true,
                tension: 0.4,
                borderWidth: 3,
                pointRadius: 4,
                pointBackgroundColor: BUCKET_LABELS.map(l => parseInt(l.split('-')[0]) >= 150 ? '#f1e05a' : '#238636')
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    display: true,
                    ticks: {
                        color: '#8b949e',
                        font: {
                            size: 9
                        }
                    },
                    grid: {
                        color: 'rgba(48, 54, 61, 0.2)'
                    }
                },
                x: {
                    ticks: {
                        color: '#8b949e',
                        font: {
                            size: 9
                        },
                        maxRotation: 45,
                        minRotation: 45
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

function updateSubjectToughestCard() {
    if (processedData.length === 0) return;
    const sub = subjects[currentSubjectIndex];
    const toughest = [...processedData].sort((a, b) => a[sub.key] - b[sub.key])[0];

    const labelEl = document.getElementById('subject-tough-label');
    labelEl.innerText = sub.label;
    labelEl.className = `text-[10px] font-bold uppercase tracking-widest ${sub.color}`;

    document.getElementById('subject-tough-val').innerText = toughest.id;
    document.getElementById('subject-avg-val').innerText = toughest[sub.key].toFixed(1);
    document.getElementById('subject-total-med').innerText = toughest.median;
}

function renderSubjectDistributionRanks() {
    const containers = {
        p: 'physics-rankings',
        c: 'chemistry-rankings',
        m: 'maths-rankings'
    };
    Object.keys(containers).forEach(key => {
        const list = document.getElementById(containers[key]);
        const subInfo = subjects.find(s => s.key === key);
        list.innerHTML = '';

        const sorted = [...processedData].sort((a, b) => a[key] - b[key]).slice(0, 3);
        sorted.forEach((s, idx) => {
            const row = document.createElement('div');
            row.className = 'flex justify-between items-center bg-gray-900/50 p-2 rounded border border-gray-800 text-[11px]';
            row.innerHTML = `
                <span class="text-gray-500 font-mono">#${idx+1} ${s.id}</span>
                <span class="${subInfo.color} font-bold">${s[key].toFixed(1)} Avg</span>
            `;
            list.appendChild(row);
        });
    });
}

function getChronologicalVal(id) {
    const match = id.replace(/\s+/g, '').match(/(\d+)[-S]*(\d+)/i);
    if (match) {
        const year = parseInt(match[1]);
        const session = parseInt(match[2]);
        return (year * 10) + session;
    }
    return 0;
}

document.getElementById('sort-mean-btn').onclick = () => {
    chartSortMode = 'mean';
    document.getElementById('sort-mean-btn').classList.add('active');
    document.getElementById('sort-date-btn').classList.remove('active');
    renderMainComparison();
    renderSubjectAnalysis();
};

document.getElementById('sort-date-btn').onclick = () => {
    chartSortMode = 'date';
    document.getElementById('sort-date-btn').classList.add('active');
    document.getElementById('sort-mean-btn').classList.remove('active');
    renderMainComparison();
    renderSubjectAnalysis();
};

document.getElementById('user-marks-input').addEventListener('input', runPercentileLogic);
document.getElementById('toggle-150-line').onchange = (e) => {
    show150Line = e.target.checked;
    renderMainComparison();
};
document.getElementById('toggle-99-line').onchange = (e) => {
    show99Line = e.target.checked;
    renderMainComparison();
};
document.getElementById('toggle-98-line').onchange = (e) => {
    show98Line = e.target.checked;
    renderMainComparison();
};
document.getElementById('subject-toughest-card').onclick = () => {
    currentSubjectIndex = (currentSubjectIndex + 1) % subjects.length;
    updateSubjectToughestCard();
};
document.getElementById('refresh-btn').onclick = initData;

window.onload = () => {
    initData();
    setInterval(initData, 900000);
};