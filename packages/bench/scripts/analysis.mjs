/**
 * Advanced Performance Analysis Module
 * Provides statistical analysis, bottleneck detection, and scaling pattern recognition
 */

export class PerformanceAnalyzer {
  constructor() {
    this.thresholds = {
      significant: 20,    // 20% difference is significant
      notable: 10,        // 10% difference is notable
      marginal: 5         // 5% difference is marginal
    };
  }

  /**
   * Analyze scaling patterns across concurrency levels
   */
  analyzeScalingPatterns(scenarios) {
    const patterns = new Map();
    
    // Group by framework
    const byFramework = new Map();
    for (const [scenario, rows] of scenarios) {
      const [conc, total] = scenario.split('x').map(Number);
      for (const row of rows) {
        if (!byFramework.has(row.server)) {
          byFramework.set(row.server, []);
        }
        byFramework.get(row.server).push({ ...row, concurrency: conc, total });
      }
    }

    // Analyze each framework's scaling
    for (const [framework, data] of byFramework) {
      const sorted = data.sort((a, b) => a.concurrency - b.concurrency);
      if (sorted.length < 2) continue;

      const analysis = this.detectScalingPattern(sorted);
      patterns.set(framework, analysis);
    }

    return patterns;
  }

  /**
   * Detect scaling pattern for a single framework
   */
  detectScalingPattern(sortedData) {
    const rpsData = sortedData.map(d => ({ x: d.concurrency, y: d.rps })).filter(d => !isNaN(d.y));
    const ttftData = sortedData.map(d => ({ x: d.concurrency, y: d.ttft_p95 })).filter(d => !isNaN(d.y));
    
    if (rpsData.length < 2) return { pattern: 'insufficient_data' };

    // Calculate efficiency (RPS per concurrency unit)
    const efficiencies = rpsData.map(d => d.y / d.x);
    const efficiencyTrend = this.calculateTrend(efficiencies);

    // Detect bottlenecks (where TTFT starts increasing rapidly)
    const ttftTrend = ttftData.length > 1 ? this.calculateTrend(ttftData.map(d => d.y)) : 0;

    // Determine scaling pattern
    let pattern = 'unknown';
    let description = '';
    let recommendations = [];

    if (efficiencyTrend < -0.1) {
      pattern = 'degrading';
      description = 'Performance degrades significantly with increased concurrency';
      recommendations.push('Investigate resource contention or synchronization bottlenecks');
      recommendations.push('Consider connection pooling or async processing optimizations');
    } else if (efficiencyTrend > 0.05) {
      pattern = 'super_linear';
      description = 'Performance improves more than linearly with concurrency';
      recommendations.push('Excellent scaling characteristics - consider higher concurrency levels');
    } else if (Math.abs(efficiencyTrend) < 0.05) {
      pattern = 'linear';
      description = 'Performance scales linearly with concurrency';
      recommendations.push('Good scaling characteristics - can handle proportional load increases');
    } else {
      pattern = 'sub_linear';
      description = 'Performance scales less than linearly but remains stable';
      recommendations.push('Consider optimizing for higher concurrency scenarios');
    }

    // Detect optimal concurrency point
    const optimalPoint = this.findOptimalConcurrency(rpsData, ttftData);

    return {
      pattern,
      description,
      recommendations,
      efficiencyTrend,
      ttftTrend,
      optimalPoint,
      dataPoints: rpsData.length
    };
  }

  /**
   * Calculate trend (slope) of a data series
   */
  calculateTrend(values) {
    if (values.length < 2) return 0;
    
    const n = values.length;
    const sumX = (n * (n - 1)) / 2; // 0 + 1 + 2 + ... + (n-1)
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((sum, y, x) => sum + x * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6; // sum of squares

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }

  /**
   * Find optimal concurrency point balancing throughput and latency
   */
  findOptimalConcurrency(rpsData, ttftData) {
    if (rpsData.length < 2) return null;

    // Calculate efficiency score: RPS / (1 + normalized_ttft)
    const scores = rpsData.map(rps => {
      const ttft = ttftData.find(t => t.x === rps.x);
      if (!ttft) return { concurrency: rps.x, score: rps.y };
      
      // Normalize TTFT (higher is worse)
      const normalizedTtft = ttft.y / 100; // Assume 100ms is baseline
      const score = rps.y / (1 + normalizedTtft);
      
      return { concurrency: rps.x, score, rps: rps.y, ttft: ttft.y };
    });

    // Find the point with highest efficiency score
    const optimal = scores.reduce((best, current) => 
      current.score > best.score ? current : best
    );

    return optimal;
  }

  /**
   * Detect performance bottlenecks
   */
  detectBottlenecks(scenarios) {
    const bottlenecks = [];

    for (const [scenario, rows] of scenarios) {
      const [conc, total] = scenario.split('x').map(Number);
      
      for (const row of rows) {
        const issues = [];

        // High TTFT variance (P99 >> P50)
        if (row.ttft_p99 && row.ttft_p50 && row.ttft_p99 > row.ttft_p50 * 3) {
          issues.push({
            type: 'high_ttft_variance',
            severity: 'high',
            description: `High TTFT variance (P99: ${row.ttft_p99.toFixed(1)}ms vs P50: ${row.ttft_p50.toFixed(1)}ms)`,
            recommendation: 'Investigate request queuing or resource contention'
          });
        }

        // Low RPS relative to concurrency
        const expectedMinRps = conc * 0.5; // Very conservative estimate
        if (row.rps && row.rps < expectedMinRps) {
          issues.push({
            type: 'low_throughput',
            severity: 'medium',
            description: `Low throughput (${row.rps.toFixed(1)} RPS with ${conc} concurrent connections)`,
            recommendation: 'Check for blocking operations or insufficient resources'
          });
        }

        // High duration variance
        if (row.dur_p95 && row.dur_p50 && row.dur_p95 > row.dur_p50 * 2) {
          issues.push({
            type: 'high_duration_variance',
            severity: 'medium',
            description: `High duration variance (P95: ${row.dur_p95.toFixed(1)}ms vs P50: ${row.dur_p50.toFixed(1)}ms)`,
            recommendation: 'Investigate streaming consistency or network issues'
          });
        }

        if (issues.length > 0) {
          bottlenecks.push({
            scenario,
            framework: row.server,
            issues
          });
        }
      }
    }

    return bottlenecks;
  }

  /**
   * Generate cost-per-request analysis
   */
  analyzeCostEfficiency(scenarios, costModel = {}) {
    const defaultCosts = {
      elide: { cpu_per_hour: 0.10, memory_per_gb_hour: 0.02 },
      express: { cpu_per_hour: 0.12, memory_per_gb_hour: 0.025 },
      fastapi: { cpu_per_hour: 0.11, memory_per_gb_hour: 0.023 },
      flask: { cpu_per_hour: 0.13, memory_per_gb_hour: 0.027 }
    };

    const costs = { ...defaultCosts, ...costModel };
    const analysis = [];

    for (const [scenario, rows] of scenarios) {
      for (const row of rows) {
        if (!row.rps || !costs[row.server]) continue;

        const framework = row.server;
        const hourlyRate = costs[framework].cpu_per_hour + costs[framework].memory_per_gb_hour;
        const requestsPerHour = row.rps * 3600;
        const costPerRequest = hourlyRate / requestsPerHour;
        const costPer1MRequests = costPerRequest * 1000000;

        analysis.push({
          scenario,
          framework,
          rps: row.rps,
          costPerRequest: costPerRequest * 1000, // in millicents
          costPer1MRequests,
          efficiency: row.rps / hourlyRate // requests per dollar per hour
        });
      }
    }

    return analysis.sort((a, b) => a.costPerRequest - b.costPerRequest);
  }

  /**
   * Generate executive insights
   */
  generateExecutiveInsights(scenarios, scalingPatterns, bottlenecks, costAnalysis) {
    const insights = [];

    // Overall performance leader
    const allResults = [];
    for (const [scenario, rows] of scenarios) {
      allResults.push(...rows.map(r => ({ ...r, scenario })));
    }

    const avgRpsByFramework = new Map();
    for (const result of allResults) {
      if (!result.rps) continue;
      if (!avgRpsByFramework.has(result.server)) {
        avgRpsByFramework.set(result.server, []);
      }
      avgRpsByFramework.get(result.server).push(result.rps);
    }

    const avgRps = new Map();
    for (const [framework, rpsList] of avgRpsByFramework) {
      const avg = rpsList.reduce((a, b) => a + b, 0) / rpsList.length;
      avgRps.set(framework, avg);
    }

    const topPerformer = Array.from(avgRps.entries())
      .sort((a, b) => b[1] - a[1])[0];

    if (topPerformer) {
      insights.push({
        type: 'performance_leader',
        title: 'Overall Performance Leader',
        description: `${topPerformer[0]} leads with ${topPerformer[1].toFixed(1)} average RPS across all scenarios`,
        priority: 'high'
      });
    }

    // Scaling insights
    for (const [framework, pattern] of scalingPatterns) {
      if (pattern.pattern === 'degrading') {
        insights.push({
          type: 'scaling_concern',
          title: `${framework} Scaling Concern`,
          description: pattern.description,
          recommendations: pattern.recommendations,
          priority: 'high'
        });
      } else if (pattern.pattern === 'super_linear') {
        insights.push({
          type: 'scaling_excellence',
          title: `${framework} Excellent Scaling`,
          description: pattern.description,
          priority: 'medium'
        });
      }
    }

    // Cost efficiency insights
    if (costAnalysis.length > 0) {
      const mostCostEffective = costAnalysis[0];
      insights.push({
        type: 'cost_efficiency',
        title: 'Most Cost-Effective',
        description: `${mostCostEffective.framework} offers the lowest cost per request at ${mostCostEffective.costPerRequest.toFixed(3)} millicents`,
        priority: 'medium'
      });
    }

    // Critical bottlenecks
    const criticalBottlenecks = bottlenecks.filter(b => 
      b.issues.some(i => i.severity === 'high')
    );

    if (criticalBottlenecks.length > 0) {
      insights.push({
        type: 'critical_bottleneck',
        title: 'Critical Performance Issues',
        description: `${criticalBottlenecks.length} scenarios show critical performance bottlenecks`,
        details: criticalBottlenecks.map(b => `${b.framework} in ${b.scenario}`),
        priority: 'high'
      });
    }

    return insights.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }
}

export default PerformanceAnalyzer;
